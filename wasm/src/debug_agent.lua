-- Lua debug agent for the REDIS_LUA_DEBUG build flavor.
--
-- Loaded by eval_debug() as a chunk receiving two arguments:
--   request     - C function __redis_debug_request(payload: string) -> string.
--                 The agent's only door to JS. Each call sends one JSON message
--                 to the host and returns the host's JSON reply. The underlying
--                 host import is the sole Asyncify suspend point, so the user's
--                 Lua frames stay live while the host decides what to do.
--   user_source - chunkname of the user script (e.g. "@<sha>"). Frames whose
--                 getinfo source matches it are "user frames"; agent/internal
--                 frames are hidden from the debugger.
--
-- Returns { onready = fn, online = fn }. C keeps registry refs and calls:
--   onready()            once per eval, before the user chunk runs (initial
--                        breakpoints + stopOnEntry handshake).
--   online(line, depth)  from the combined C hook on every LUA_HOOKLINE event
--                        in a user frame. Decides locally whether to stop; only
--                        crosses to JS when it actually stops.
--
-- Protocol (JSON, one request/reply pair per crossing):
--   agent -> host: {event="ready"}
--                  {event="stopped", reason, line, depth}
--                  {event="result", id, body}
--                  {event="error", id, message}
--   host -> agent: {action="resume", mode, breakpoints=[lines], stopOnEntry?}
--                  {action="inspect", id, op, args}
--                  {action="cancel", reason}
--
-- The globals table is readonly (globals protection), so all agent state lives
-- in locals/upvalues; nothing is installed globally.

local request, user_source = ...

local json = cjson
local getinfo = debug.getinfo
local getlocal = debug.getlocal
local getupvalue = debug.getupvalue

local CANCEL_MARKER = "__RLUA_DEBUG_CANCEL__"
local MAX_CHILDREN = 200

-- Debugger state, updated by each resume reply.
local breakpoints = {} -- line -> true
local mode = "continue" -- continue | stepOver | stepIn | stepOut
local step_depth = 0 -- user stack depth captured at resume, for over/out
local at_entry = false -- next stop reports reason "entry" (stopOnEntry)

-- variablesReference handles, reset at every stop. ref -> descriptor:
--   {kind="locals", frame=i} | {kind="upvalues", frame=i} | {kind="table", value=t}
local handles = {}
local next_ref = 0

local function new_handle(desc)
  next_ref = next_ref + 1
  handles[next_ref] = desc
  return next_ref
end

-- Render a Lua value for display. Strings are %q-quoted (binary-safe enough
-- for a debugger panel); tables/functions fall back to tostring.
local function render(v)
  local t = type(v)
  if t == "string" then
    return string.format("%q", v)
  end
  return tostring(v)
end

local function describe(name, v)
  local entry = { name = tostring(name), value = render(v), type = type(v), ref = 0 }
  if type(v) == "table" then
    entry.ref = new_handle({ kind = "table", value = v })
  end
  return entry
end

-- Levels of user frames *relative to this function's caller* (top frame
-- first). Every op that touches the stack calls this and then performs its
-- debug.getlocal/getinfo calls directly in its own body, so the relative
-- levels stay valid. DAP frame index 0 == first entry.
local function user_frames()
  local out = {}
  local level = 2 -- level 1 is user_frames itself; 2 is the caller
  while true do
    local info = getinfo(level, "S")
    if not info then
      break
    end
    if info.source == user_source then
      out[#out + 1] = level - 1 -- rebase onto the caller's perspective
    end
    level = level + 1
  end
  return out
end

local ops = {}

function ops.stackTrace()
  local frames = user_frames()
  local out = {}
  for i, level in ipairs(frames) do
    local info = getinfo(level, "nSl")
    local name
    if info.what == "main" then
      name = "(main chunk)"
    else
      name = info.name or ("(anonymous:" .. (info.linedefined or 0) .. ")")
    end
    out[#out + 1] = { index = i - 1, name = name, line = info.currentline }
  end
  return out
end

function ops.scopes(args)
  local frame = args.frame or 0
  local script_args = {}
  -- KEYS/ARGV are plain globals; surface them in their own scope.
  script_args.KEYS = KEYS
  script_args.ARGV = ARGV
  return {
    { name = "Locals", ref = new_handle({ kind = "locals", frame = frame }) },
    { name = "Upvalues", ref = new_handle({ kind = "upvalues", frame = frame }) },
    { name = "Script Args", ref = new_handle({ kind = "table", value = script_args }) },
  }
end

function ops.variables(args)
  local handle = handles[args.ref or 0]
  if not handle then
    error("unknown variablesReference", 0)
  end
  local out = {}

  if handle.kind == "locals" then
    local frames = user_frames()
    local level = frames[handle.frame + 1]
    if not level then
      error("no such frame", 0)
    end
    local i = 1
    while true do
      local name, value = getlocal(level, i)
      if not name then
        break
      end
      if name:sub(1, 1) ~= "(" then -- skip "(*temporary)" and internals
        out[#out + 1] = describe(name, value)
      end
      i = i + 1
    end
    return out
  end

  if handle.kind == "upvalues" then
    local frames = user_frames()
    local level = frames[handle.frame + 1]
    if not level then
      error("no such frame", 0)
    end
    local func = getinfo(level, "f").func
    local i = 1
    while true do
      local name, value = getupvalue(func, i)
      if not name then
        break
      end
      out[#out + 1] = describe(name, value)
      i = i + 1
    end
    return out
  end

  -- kind == "table": lazy expansion of a captured table value.
  local count = 0
  for k, v in pairs(handle.value) do
    count = count + 1
    if count > MAX_CHILDREN then
      out[#out + 1] = { name = "...", value = "(truncated)", type = "string", ref = 0 }
      break
    end
    out[#out + 1] = describe(k, v)
  end
  return out
end

function ops.evaluate(args)
  local frames = user_frames()
  local level = frames[(args.frame or 0) + 1]
  if not level then
    error("no such frame", 0)
  end

  -- Paused-frame environment: upvalues first, locals shadow them, _G behind
  -- both via __index (so redis.call etc. work and hit the live keyspace).
  local env = {}
  local func = getinfo(level, "f").func
  local i = 1
  while true do
    local name, value = getupvalue(func, i)
    if not name then
      break
    end
    env[name] = value
    i = i + 1
  end
  i = 1
  while true do
    local name, value = getlocal(level, i)
    if not name then
      break
    end
    if name:sub(1, 1) ~= "(" then
      env[name] = value
    end
    i = i + 1
  end
  setmetatable(env, { __index = _G })

  local expr = tostring(args.expression or "")
  -- Read-oriented v1: try as an expression first, then as a statement.
  local chunk, err = loadstring("return " .. expr, "@debug-eval")
  if not chunk then
    chunk, err = loadstring(expr, "@debug-eval")
  end
  if not chunk then
    error(tostring(err), 0)
  end
  setfenv(chunk, env)
  local ok, result = pcall(chunk)
  if not ok then
    error(tostring(result), 0)
  end
  local entry = describe("result", result)
  return { value = entry.value, type = entry.type, ref = entry.ref }
end

local function apply_resume(cmd, depth)
  breakpoints = {}
  if type(cmd.breakpoints) == "table" then
    for _, line in ipairs(cmd.breakpoints) do
      breakpoints[line] = true
    end
  end
  mode = cmd.mode or "continue"
  step_depth = depth
end

-- Ping-pong command loop entered when the script stops (and once at ready).
-- Exits only on a resume reply; cancel raises, aborting the script.
local function pump(message, depth)
  handles = {}
  next_ref = 0
  local reply = request(json.encode(message))
  while true do
    local cmd = json.decode(reply)
    if cmd.action == "resume" then
      apply_resume(cmd, depth)
      if cmd.stopOnEntry then
        mode = "stepIn"
        at_entry = true
      end
      return
    elseif cmd.action == "cancel" then
      error(CANCEL_MARKER .. ": " .. tostring(cmd.reason or "cancelled by debugger"), 0)
    elseif cmd.action == "inspect" then
      local ok, body = pcall(ops[cmd.op] or function()
        error("unknown op: " .. tostring(cmd.op), 0)
      end, cmd.args or {})
      local response
      if ok then
        response = { event = "result", id = cmd.id, body = body }
      else
        response = { event = "error", id = cmd.id, message = tostring(body) }
      end
      reply = request(json.encode(response))
    else
      error("unknown debug command: " .. tostring(cmd.action), 0)
    end
  end
end

local agent = {}

function agent.onready()
  pump({ event = "ready" }, 0)
end

function agent.online(line, depth)
  local reason
  if at_entry then
    reason = "entry"
  elseif mode == "stepIn" then
    reason = "step"
  elseif mode == "stepOver" and depth <= step_depth then
    reason = "step"
  elseif mode == "stepOut" and depth < step_depth then
    reason = "step"
  elseif breakpoints[line] then
    reason = "breakpoint"
  end
  if not reason then
    return
  end
  at_entry = false
  pump({ event = "stopped", reason = reason, line = line, depth = depth }, depth)
end

return agent
