/**
 * Redis error model: table error objects (#37), Redis 7 `{err=...}` errors from
 * redis.call and the unwrapping global pcall (#48), and a fuel kill that
 * cannot be caught by pcall (#38).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaEngine } from "../src/index.js";
import type { CompatProfile, CompatOverrides, EngineLimits, RedisHost, ReplyValue } from "../src/types.js";

type ErrReply = { err: Buffer; code?: Buffer; meta?: { line: number; kind?: string } };

const host: RedisHost = {
  redisCall(args) {
    switch (args[0]?.toString("utf8")) {
      case "nope":
        return { err: Buffer.from("ERR unknown command 'nope'") };
      case "bare":
        return { err: Buffer.from("boom\r\n") };
      case "wrongtype":
        return { err: Buffer.from("Operation against a key holding the wrong kind of value"), code: Buffer.from("WRONGTYPE") };
      default:
        return { ok: Buffer.from("OK") };
    }
  },
  redisPcall(args, ctx) {
    return this.redisCall(args, ctx);
  },
  log() {},
};

async function engineFor(
  profile?: CompatProfile,
  limits?: EngineLimits,
  compat?: CompatOverrides,
): Promise<LuaEngine> {
  return (await load({ profile, limits, compat })).create(host);
}

function assertErr(value: ReplyValue, code: string, message: string, line?: number): ErrReply {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  const reply = value as ErrReply;
  assert.equal(reply.err.toString("utf8"), message);
  assert.equal(reply.code?.toString("utf8"), code);
  if (line !== undefined) {
    assert.equal(reply.meta?.line, line);
  }
  return reply;
}

function strings(value: ReplyValue): string[] {
  assert.ok(Array.isArray(value), `expected an array, got ${String(value)}`);
  return value.map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item)));
}

function assertUsable(engine: LuaEngine): void {
  assert.equal(engine.eval("return 1 + 1"), 2);
  assert.deepEqual(engine.eval("return {pcall(function(a) return a * 2 end, 21)}"), [1, 42]);
}

const TABLE_PROFILES: Array<CompatProfile | undefined> = [undefined, "redis-7.0", "redis-8.0", "valkey-8.0"];
const ALL_PROFILES: Array<CompatProfile | undefined> = [...TABLE_PROFILES, "redis-6.2"];

// =============================================================================
// Table error objects (#37)
// =============================================================================

for (const profile of ALL_PROFILES) {
  const name = profile ?? "default";

  test(`error model (${name}): error() with a table reports its err field`, async () => {
    const engine = await engineFor(profile);
    assertErr(engine.eval("error({err='MY custom'})"), "MY", "custom", 1);
    assertErr(engine.eval("local x = 1\nerror(redis.error_reply('boom'))"), "ERR", "boom", 2);
    assertErr(engine.eval("error({err='WRONGTYPE bad\\r\\nvalue'})"), "WRONGTYPE", "bad  value");
    // Like luaExtractErrorInformation: no string `err` field -> "ERR unknown error".
    assertErr(engine.eval("error({})"), "ERR", "unknown error");
    assertErr(engine.eval("error({err=true})"), "ERR", "unknown error");
    assertErr(engine.eval("error({err=7})"), "ERR", "7");
    assertUsable(engine);
  });

  test(`error model (${name}): non-string error values are reported like tostring`, async () => {
    const engine = await engineFor(profile);
    assertErr(engine.eval("error(nil)"), "ERR", "nil", 1);
    assertErr(engine.eval("error(false)"), "ERR", "false");
    assertErr(engine.eval("error(true, 0)"), "ERR", "true");
    const fn = engine.eval("error(function() end)") as ErrReply;
    assert.equal(fn.code?.toString("utf8"), "ERR");
    assert.match(fn.err.toString("utf8"), /^function: /);
    assertUsable(engine);
  });
}

// =============================================================================
// Redis 7 error tables and the unwrapping pcall (#48)
// =============================================================================

const XPCALL_TYPE = "return select(2, xpcall(function() redis.call('nope') end, function(e) return type(e) end))";

for (const profile of TABLE_PROFILES) {
  const name = profile ?? "default";

  test(`error model (${name}): redis.call raises a table, pcall unwraps it`, async () => {
    const engine = await engineFor(profile);
    assert.equal((engine.eval(XPCALL_TYPE) as Buffer).toString(), "table");
    // The table redis.call raises is the one redis.pcall returns (Redis 7's
    // redisProtocolToLuaType_Error), including ignore_error_stats_update.
    const fields = "return {e.err, tostring(e.ignore_error_stats_update)}";
    assert.deepEqual(
      strings(engine.eval(`return select(2, xpcall(function() redis.call('nope') end, function(e) ${fields} end))`)),
      ["ERR unknown command 'nope'", "true"],
    );
    assert.deepEqual(strings(engine.eval(`local e = redis.pcall('nope') ${fields}`)), [
      "ERR unknown command 'nope'",
      "true",
    ]);
    // A code-less host error gets the generic ERR code and loses trailing CRLF.
    assert.deepEqual(strings(engine.eval(`local e = redis.pcall('bare') ${fields}`)), ["ERR boom", "true"]);

    // pcall returns the err string of a caught error table.
    assert.deepEqual(strings(engine.eval("local ok, e = pcall(redis.call, 'nope') return {tostring(ok), type(e), e}")), [
      "false",
      "string",
      "ERR unknown command 'nope'",
    ]);
    assert.deepEqual(strings(engine.eval("return {tostring(pcall(error, {err='x'})), select(2, pcall(error, {err='x'}))}")), [
      "false",
      "x",
    ]);
    // Anything else passes through as with the stock pcall.
    assert.deepEqual(strings(engine.eval("local ok, e = pcall(error, {}) return {tostring(ok), type(e)}")), ["false", "table"]);
    assert.deepEqual(engine.eval("return {pcall(function(a, b) return a + b, 'x' end, 1, 2)}"), [1, 3, Buffer.from("x")]);
    assert.deepEqual(engine.eval("return {pcall(error, 'msg', 0)}"), [null, Buffer.from("msg")]);
    assertErr(engine.eval("pcall()"), "ERR", "user_script:1: bad argument #1 to 'pcall' (value expected)");
    assertUsable(engine);
  });

  test(`error model (${name}): uncaught redis.call errors keep their code and line`, async () => {
    const engine = await engineFor(profile);
    assertErr(engine.eval("redis.call('SET', 'k', 'v')\nredis.call('nope')"), "ERR", "unknown command 'nope'", 2);
    assertErr(engine.eval("\n\nredis.call('wrongtype')"), "WRONGTYPE", "Operation against a key holding the wrong kind of value", 3);
    // The rest of the redis.* errors are tables too, and still reach the host
    // the same way.
    assert.equal((engine.eval("return select(2, xpcall(function() redis.log(9, 'x') end, function(e) return type(e) end))") as Buffer).toString(), "table");
    assert.equal((engine.eval("local ok, e = pcall(redis.log, 9, 'x') return e") as Buffer).toString(), "ERR Invalid log level.");
    assertErr(engine.eval("redis.setresp(4)"), "ERR", "RESP version must be 2 or 3.", 1);
    const argType = assertErr(engine.eval("redis.call({})"), "ERR", "command-arg-type", 1);
    assert.equal(argType.meta?.kind, "command-arg-type");
    assertUsable(engine);
  });
}

test("error model (redis-6.2): redis.call raises a string, pcall is the stock one", async () => {
  const engine = await engineFor("redis-6.2");
  assert.equal((engine.eval(XPCALL_TYPE) as Buffer).toString(), "string");
  assert.deepEqual(strings(engine.eval("local ok, e = pcall(redis.call, 'nope') return {tostring(ok), type(e), e}")), [
    "false",
    "string",
    "ERR unknown command 'nope'",
  ]);
  // Host errors reach the script verbatim, as in Redis 6.2.
  assert.deepEqual(strings(engine.eval("local ok, e = pcall(redis.call, 'bare') return {e}")), ["boom\r\n"]);
  assert.deepEqual(
    strings(engine.eval("local e = redis.pcall('nope') return {e.err, tostring(e.ignore_error_stats_update)}")),
    ["ERR unknown command 'nope'", "nil"],
  );
  assert.deepEqual(strings(engine.eval("local ok, e = pcall(error, {err='x'}) return {tostring(ok), type(e)}")), [
    "false",
    "table",
  ]);
  assert.equal((engine.eval("return select(2, xpcall(function() redis.log(9, 'x') end, function(e) return type(e) end))") as Buffer).toString(), "string");
  assertErr(engine.eval("redis.call('SET', 'k', 'v')\nredis.call('nope')"), "ERR", "unknown command 'nope'", 2);
  assertUsable(engine);
});

test("error model: the tableErrors override is merged over the profile", async () => {
  const off = await engineFor("redis-7.2", undefined, { tableErrors: false });
  assert.equal((off.eval(XPCALL_TYPE) as Buffer).toString(), "string");
  const on = await engineFor("redis-6.2", undefined, { tableErrors: true });
  assert.equal((on.eval(XPCALL_TYPE) as Buffer).toString(), "table");
  // The flag is independent of reseedRandom (0x8): redis-6.2 still reseeds per
  // script, redis-7.2 still keeps one sequence running.
  const random = "return math.random(1, 1000000)";
  assert.equal(on.eval(random), on.eval(random));
  assert.notEqual(off.eval(random), off.eval(random));
});

// =============================================================================
// Fuel kill escapes pcall (#38)
// =============================================================================

const KILL = ["ERR", "Script killed by fuel limit"] as const;

// A regression hangs rather than fails, so these tests carry a timeout.
const FUEL_TEST = { timeout: 30_000 };
const WITHIN_BUDGET = "local n = 0 for i = 1, 10000 do n = n + i end return n";

// `n` levels of string.gsub callbacks (C frames) around `body`.
function inGsubNest(n: number, body: string): string {
  return `local function f(n) if n == 0 then ${body} end return (string.gsub('x', 'x', function() return f(n - 1) end)) end return f(${n})`;
}

for (const profile of [undefined, "redis-6.2"] as const) {
  const name = profile ?? "default";

  test(`fuel (${name}): a kill cannot be caught by pcall`, FUEL_TEST, async () => {
    const engine = await engineFor(profile, { maxFuel: 100_000 });
    const scripts = [
      "while true do end",
      // The #38 repro: the inner pcall used to absorb the kill forever.
      "while true do pcall(function() while true do end end) end",
      "local ok, e = pcall(function() while true do end end)\nreturn e",
      "while true do xpcall(function() while true do end end, function(e) return e end) end",
      // No message handler runs for the kill, so a looping one cannot hang.
      "while true do xpcall(function() while true do end end, function(e) while true do end end) end",
      "local co = coroutine.wrap(function() while true do pcall(function() while true do end end) end end)\nwhile true do pcall(co) end",
      "local function f() return pcall(f) end\nwhile true do f() end",
    ];
    for (const script of scripts) {
      assertErr(engine.eval(script), ...KILL);
      // The counting hook is restored: a script within budget runs again.
      assert.equal(engine.eval(WITHIN_BUDGET), 50005000, script);
    }
    assertUsable(engine);
  });

  test(`fuel (${name}): a kill inside a coroutine is not swallowed by resume`, FUEL_TEST, async () => {
    const engine = await engineFor(profile, { maxFuel: 100_000 });
    const swallowed = "local co = coroutine.create(function() while true do end end)\nlocal ok, e = coroutine.resume(co)\nreturn {tostring(ok), 'returned normally'}";
    assertErr(engine.eval(swallowed), ...KILL, 1);
    // The resumer is stopped right away too, even inside its own pcall loop.
    const resumer = "while true do pcall(coroutine.resume, coroutine.create(function() while true do end end)) end";
    assertErr(engine.eval(resumer), ...KILL);
    assert.equal(engine.eval(WITHIN_BUDGET), 50005000);
    assertUsable(engine);
  });

  test(`fuel (${name}): the kill line is where the budget ran out`, FUEL_TEST, async () => {
    const engine = await engineFor(profile, { maxFuel: 100_000 });
    assertErr(engine.eval("local x = 1\n\nwhile true do end"), ...KILL, 3);
    assertErr(engine.eval("local x = 1\nlocal ok = pcall(function()\n  while true do end\nend)"), ...KILL, 3);
  });

  test(`fuel (${name}): an xpcall kill under nested C calls stays within the C stack`, FUEL_TEST, async () => {
    const engine = await engineFor(profile, { maxFuel: 100_000 });
    const loop = "while true do xpcall(function() while true do end end, function(e) return e end) end";
    for (const depth of [29, 30, 31, 40]) {
      assertErr(engine.eval(inGsubNest(depth, loop)), ...KILL);
      assertUsable(engine);
    }
  });
}
