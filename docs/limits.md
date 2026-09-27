# Resource Limits

## Execution Limits
- Instruction fuel limit: 10,000,000 Lua VM instructions per script by default
  (`maxFuel`), charged in steps of 1000. This is a deterministic budget, not
  Redis's wall-clock `lua-time-limit`: there is no `BUSY` state or
  `SCRIPT KILL`, and time spent in host callbacks or C functions is not charged.
- Fuel exhaustion behavior: the script aborts with the error
  `ERR Script killed by fuel limit` (Redis: `ERR Script killed by user with
  SCRIPT KILL...`). Like a Redis `SCRIPT KILL`, it cannot be caught: after a
  `pcall`/`xpcall` catches it, it is raised again at the next instruction until
  it escapes the script.

## Memory Limits
- WASM linear memory: 64 MiB max.
- Max argument buffer size: 8 MiB per call.
- Max reply size: 8 MiB per script result.

## Stack Limits
These come from the Lua 5.1 build in `vendor/redis/deps/lua` (`luaconf.h`):
- Lua stack slots usable by a C function (`lua_checkstack`): 8000
  (`LUAI_MAXCSTACK`).
- Nested Lua calls: 20000 (`LUAI_MAXCALLS`).
- Nested C calls (C functions, metamethods, `pcall`) and parser nesting: 200
  (`LUAI_MAXCCALLS`).

Reply nesting:
- Script return values: nested at most 1000 levels deep. Deeper (or cyclic)
  tables reply `ERR reached lua stack limit` instead of the value.
- Host replies decoded by `redis.call`/`redis.pcall`: the WASM decoder accepts
  up to 1000 levels, and deeper replies raise `ERR reached lua stack limit` in
  the script. The JS side encodes the host's `ReplyValue` recursively
  (`encodeReplyValue`), though, and that can overflow the JS stack before the
  WASM limit is reached: from about 3000 levels for arrays, and at lower depths
  for `{map=}` replies or when `redis.call` runs under many nested Lua `pcall`
  frames, because WASM frames share the JS stack. That failure surfaces as an
  error reply carrying `Maximum call stack size exceeded` (raised by
  `redis.call`, returned by `redis.pcall`), not as `ERR reached lua stack
  limit`. Keep host replies shallow.

## Safety Notes
- Limits are enforced consistently across all entrypoints.
- Limits are configurable at host initialization time.
