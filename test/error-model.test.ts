/**
 * Redis error model: table error objects (#37), Redis 7 `{err=...}` errors from
 * redis.call and the unwrapping global pcall (#48), a fuel kill that cannot be
 * caught by pcall (#38), engine errors flagged over the ABI instead of matched
 * by their text (#59) and code-less table errors (#76).
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
      case "oops":
        return { err: Buffer.from("oops something") };
      case "throw":
        throw new Error("oops thrown");
      case "echoerr":
        return { err: Buffer.concat([Buffer.from("ERR wrong type for key "), args[1] ?? Buffer.alloc(0)]) };
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

/** `code` undefined asserts a code-less error (no `code` key at all). */
function assertErr(value: ReplyValue, code: string | undefined, message: string, line?: number): ErrReply {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  const reply = value as ErrReply;
  assert.equal(reply.err.toString("utf8"), message);
  assert.equal(reply.code?.toString("utf8"), code);
  if (code === undefined) {
    assert.ok(!("code" in reply), "a code-less error has no code key");
  }
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

  // Redis 7 sends a table error's err as-is, so its code is its first word, if
  // any (#76); Redis 6.2 replies "-ERR ..." for every script error (#83).
  const v62 = profile === "redis-6.2";
  const bare = v62 ? "ERR" : undefined;
  const coded = (code: string, message: string): [string, string] =>
    v62 ? ["ERR", `${code} ${message}`] : [code, message];

  test(`error model (${name}): error() with a table reports its err field`, async () => {
    const engine = await engineFor(profile);
    assertErr(engine.eval("error({err='MY custom'})"), ...coded("MY", "custom"), 1);
    assertErr(engine.eval("local x = 1\nerror(redis.error_reply('boom'))"), "ERR", "boom", 2);
    assertErr(engine.eval("error({err='WRONGTYPE bad\\r\\nvalue'})"), ...coded("WRONGTYPE", "bad  value"));
    // Like luaExtractErrorInformation: no string `err` field -> "ERR unknown error".
    assertErr(engine.eval("error({})"), "ERR", "unknown error");
    assertErr(engine.eval("error({err=true})"), "ERR", "unknown error");
    // Redis 7 sends a table's err as-is ("-7"): no code is invented (#76).
    assertErr(engine.eval("error({err=7})"), bare, "7");
    assertUsable(engine);
  });

  test(`error model (${name}): a table error without a code is code-less in the Redis 7 model (#76)`, async () => {
    const engine = await engineFor(profile);
    // Redis 7: `-boom script: <sha>, on @user_script:1.`, not `-ERR boom ...`;
    // Redis 6.2: `-ERR Error running script ...`.
    assertErr(engine.eval("error({err='boom'})"), bare, "boom", 1);
    assertErr(engine.eval("\nerror({err='oops something'})"), bare, "oops something", 2);
    assertErr(engine.eval("error({err='My Error x'})"), bare, "My Error x");
    assertErr(engine.eval("error({err='boom\\r\\n'})"), bare, "boom");
    assertErr(engine.eval("error({err='MY boom'})"), ...coded("MY", "boom"), 1);
    // A code-less host error reply, raised by redis.call or rethrown from
    // redis.pcall, gets the same code either way.
    assertErr(engine.eval("return redis.call('oops')"), bare, "oops something", 1);
    assertErr(engine.eval("local e = redis.pcall('oops')\nerror(e)"), bare, "oops something", 2);
    // A thrown host exception is a host failure, not a Redis reply: always ERR.
    // Redis 6.2's redis.call raises a command error reply's text as it is
    // ("ERR oops thrown"), which its script error keeps whole (#93).
    assertErr(engine.eval("return redis.call('throw')"), "ERR", v62 ? "ERR oops thrown" : "oops thrown", 1);
    assert.deepEqual(engine.eval("return redis.pcall('throw')"), {
      err: Buffer.from("oops thrown"),
      code: Buffer.from("ERR"),
    });
    assertUsable(engine);
  });

  test(`error model (${name}): an uncaught string error always has code ERR (#83)`, async () => {
    const engine = await engineFor(profile);
    // Redis 7 wraps it as {err='ERR ' .. tostring(err)}; Redis 6.2 replies
    // "-ERR Error running script ...". Its first word is never the code.
    assertErr(engine.eval("error('boom', 0)"), "ERR", "boom");
    assertErr(engine.eval("error('boom')"), "ERR", "user_script:1: boom", 1);
    assertErr(engine.eval("error('MY boom', 0)"), "ERR", "MY boom");
    assertErr(engine.eval("error('WRONGTYPE x\\r\\ny', 0)"), "ERR", "WRONGTYPE x  y");
    assertErr(engine.eval("error(42)"), "ERR", "user_script:1: 42");
    // "ERR" included: Redis 7 sends "-ERR ERR foo", Redis 6.2 keeps "ERR foo"
    // in its message (#93).
    assertErr(engine.eval("error('ERR foo', 0)"), "ERR", "ERR foo");
    assertErr(engine.eval("error('ERRX foo', 0)"), "ERR", "ERRX foo");
    // Compile errors have the same code and message (flagged meta.kind
    // "compile", see compile.test.ts).
    assertErr(engine.eval("return +"), "ERR", "user_script:1: unexpected symbol near '+'", 1);
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
    // Redis 7.0/7.2 word it "debug level" (#67).
    assert.equal(
      (engine.eval("local ok, e = pcall(redis.log, 9, 'x') return e") as Buffer).toString(),
      profile === "redis-7.0" ? "ERR Invalid debug level." : "ERR Invalid log level.",
    );
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
  // Redis 6.2 raises the command error reply's text as it is and keeps it
  // whole: "-ERR Error running script ...: @user_script:2: ERR unknown ..." (#93).
  assertErr(engine.eval("redis.call('SET', 'k', 'v')\nredis.call('nope')"), "ERR", "ERR unknown command 'nope'", 2);
  // Redis 6.2: "-ERR Error running script ...: @user_script:3: WRONGTYPE ..." (#83).
  assertErr(engine.eval("\n\nredis.call('wrongtype')"), "ERR", "WRONGTYPE Operation against a key holding the wrong kind of value", 3);
  assertUsable(engine);
});

test("error model: code-less table errors follow the tableErrors override (#76)", async () => {
  const off = await engineFor(undefined, undefined, { tableErrors: false });
  assertErr(off.eval("error({err='boom'})"), "ERR", "boom", 1);
  assertErr(off.eval("return redis.call('oops')"), "ERR", "oops something", 1);
  const on = await engineFor("redis-6.2", undefined, { tableErrors: true });
  assertErr(on.eval("error({err='boom'})"), undefined, "boom", 1);
  assertErr(on.eval("return redis.call('oops')"), undefined, "oops something", 1);
  // The fuel kill carries its code in both models.
  for (const tableErrors of [false, true]) {
    const engine = await engineFor(undefined, { maxFuel: 100_000 }, { tableErrors });
    assertErr(engine.eval("while true do end"), "ERR", "Script killed by fuel limit", 1);
  }
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
// Engine errors are flagged by the engine, not recognized by their text (#59)
// =============================================================================

function assertNoCrLf(reply: ErrReply): void {
  assert.ok(!/[\r\n]/.test(reply.err.toString("latin1")), `CR/LF in err: ${JSON.stringify(reply.err.toString())}`);
  assert.equal(reply.meta?.kind, undefined, "not an engine error");
}

for (const profile of ALL_PROFILES) {
  const name = profile ?? "default";

  test(`error model (${name}): marker text a script raises is sanitized, not an engine error`, async () => {
    const engine = await engineFor(profile);
    assertNoCrLf(assertErr(engine.eval("error('__RLUA_E__:x\\r\\ny')"), "ERR", "user_script:1: __RLUA_E__:x  y", 1));
    assertNoCrLf(assertErr(engine.eval("error('__RLUA_E__:x\\r\\n+OK', 0)"), "ERR", "__RLUA_E__:x  +OK"));
    // A spoofed globals-protection error is reported as what it is.
    assertNoCrLf(assertErr(engine.eval("error('__RLUA_E__:global-read:foo', 0)"), "ERR", "__RLUA_E__:global-read:foo"));
    assertNoCrLf(assertErr(engine.eval("error({err='__RLUA_E__:global-read:foo'})"), profile === "redis-6.2" ? "ERR" : undefined, "__RLUA_E__:global-read:foo"));
    // A real engine error earlier in the script does not vouch for a later one.
    assertNoCrLf(
      assertErr(
        engine.eval("pcall(function() return nope end)\nerror('__RLUA_E__:global-read:x\\r\\ny', 0)"),
        "ERR",
        "__RLUA_E__:global-read:x  y",
        2,
      ),
    );
    // Nor does one from a previous eval.
    assert.equal((engine.eval("return nope") as ErrReply).meta?.kind, "global-read");
    assertNoCrLf(assertErr(engine.eval("error('__RLUA_E__:global-read:nope', 0)"), "ERR", "__RLUA_E__:global-read:nope"));
    assertUsable(engine);
  });

  test(`error model (${name}): host errors carrying marker text are sanitized, not engine errors`, async () => {
    const engine = await engineFor(profile);
    const key = "'__RLUA_E__:global-read:x\\r\\n+OK'";
    // Redis 6.2 keeps a raised command error's own code in the message (#93).
    const own = profile === "redis-6.2" ? "ERR " : "";
    assertNoCrLf(
      assertErr(engine.eval(`redis.call('echoerr', ${key})`), "ERR", `${own}wrong type for key __RLUA_E__:global-read:x  +OK`, 1),
    );
    // A thrown host error takes the same path.
    const thrower = (await load({ profile })).create({
      ...host,
      redisCall(args) {
        throw new Error(`ERR no such key ${args[1]?.toString("utf8")}`);
      },
    });
    assertNoCrLf(assertErr(thrower.eval(`redis.call('get', ${key})`), "ERR", `${own}no such key __RLUA_E__:global-read:x  +OK`));
  });

  test(`error model (${name}): real engine errors keep their kind and raw name`, async () => {
    const engine = await engineFor(profile);
    const read = assertErr(engine.eval("local a = 1\nreturn _G['a\\r\\nb']"), "ERR", "global-read", 2);
    assert.equal(read.meta?.kind, "global-read");
    assert.equal((read.meta as { name?: string }).name, "a\r\nb");
    const argType = assertErr(engine.eval("redis.call({})"), "ERR", "command-arg-type", 1);
    assert.equal(argType.meta?.kind, "command-arg-type");
    assert.ok(!("name" in (argType.meta ?? {})));
    // Caught and rethrown unchanged, it is still the engine's error (like
    // rethrowing Redis's own error table).
    const rethrown = engine.eval("local ok, e = pcall(function() return nope end)\nerror(e, 0)") as ErrReply;
    assert.equal(rethrown.meta?.kind, "global-read");
    assert.equal((rethrown.meta as { name?: string }).name, "nope");
    assertUsable(engine);
  });
}

// =============================================================================
// A caught engine error reads like Redis's, never like the kind (#87)
// =============================================================================

type EngineErrorCase = {
  label: string;
  profile?: CompatProfile;
  compat?: CompatOverrides;
  /** Redis 7 error model ({err=...} tables, unwrapping pcall). */
  table: boolean;
  /** Valkey's "Command arguments ..." wording. */
  valkey: boolean;
};

const ENGINE_ERROR_CASES: EngineErrorCase[] = [
  { label: "default", table: true, valkey: false },
  { label: "redis-6.2", profile: "redis-6.2", table: false, valkey: false },
  { label: "redis-7.0", profile: "redis-7.0", table: true, valkey: false },
  { label: "redis-7.2", profile: "redis-7.2", table: true, valkey: false },
  { label: "redis-7.4", profile: "redis-7.4", table: true, valkey: false },
  { label: "redis-8.0", profile: "redis-8.0", table: true, valkey: false },
  { label: "valkey-8.0", profile: "valkey-8.0", table: true, valkey: true },
  { label: "valkey-9.0", profile: "valkey-9.0", table: true, valkey: true },
  { label: "default, tableErrors: false", compat: { tableErrors: false }, table: false, valkey: false },
  { label: "valkey-8.0, tableErrors: false", profile: "valkey-8.0", compat: { tableErrors: false }, table: false, valkey: true },
  { label: "redis-6.2, tableErrors: true", profile: "redis-6.2", compat: { tableErrors: true }, table: true, valkey: false },
];

const MARKER = "__RLUA_E__";

/**
 * The command-arg-type message a script sees, as each version's luaPushError
 * builds it: "ERR <msg>" in the Redis 7 model, "<source>: <line>: <msg>" in
 * Redis 6.2's (`at` is that position: "=[C]: -1" when pcall calls redis.call
 * directly, "@user_script: <line>" from script code).
 */
function argTypeError(c: EngineErrorCase, at: string): string {
  if (!c.table) {
    return `${at}: Lua redis() command arguments must be strings or integers`;
  }
  return c.valkey
    ? "ERR Command arguments must be strings or integers"
    : "ERR Lua redis lib command arguments must be strings or integers";
}

function globalReadError(line: number, name = "nope"): string {
  return `user_script:${line}: Script attempted to access nonexistent global variable '${name}'`;
}

function bulk(value: ReplyValue): string {
  assert.ok(Buffer.isBuffer(value), `expected a bulk string, got ${JSON.stringify(value)}`);
  const text = value.toString("utf8");
  assert.ok(!text.includes(MARKER), `marker visible to the script: ${text}`);
  return text;
}

function assertEngineError(value: ReplyValue, kind: string, line: number, name?: string): void {
  const reply = assertErr(value, "ERR", kind, line);
  assert.equal(reply.meta?.kind, kind);
  assert.equal((reply.meta as { name?: string }).name, name);
  assert.equal("name" in (reply.meta ?? {}), name !== undefined);
}

function assertNotEngineError(value: ReplyValue, code: string | undefined, message: string, line?: number): void {
  const reply = assertErr(value, code, message, line);
  assert.equal(reply.meta?.kind, undefined, "not an engine error");
}

async function engineForCase(c: EngineErrorCase, redisHost: RedisHost = host): Promise<LuaEngine> {
  return (await load({ profile: c.profile, compat: c.compat })).create(redisHost);
}

for (const c of ENGINE_ERROR_CASES) {
  test(`engine errors (${c.label}): a caught bad redis.call argument reads like Redis`, async () => {
    const engine = await engineForCase(c);
    for (const arg of ["{}", "true", "nil", "function() end"]) {
      const script = `return {pcall(redis.call, 'set', 'k', ${arg})}`;
      const reply = engine.eval(script);
      assert.ok(Array.isArray(reply) && reply.length === 2, `${script} -> ${JSON.stringify(reply)}`);
      assert.equal(reply[0], null, script); // false
      assert.equal(bulk(reply[1]), argTypeError(c, "=[C]: -1"), script);
    }
    // From script code, Redis 6.2's message names the calling line.
    assert.equal(
      bulk(engine.eval("local ok, e = pcall(function()\n\nreturn redis.call('set', 'k', {}) end)\nreturn e")),
      argTypeError(c, "@user_script: 3"),
    );
    // An xpcall handler gets the raw error: Redis 7's {err=...} table, Redis
    // 6.2's string.
    assert.deepEqual(
      strings(
        engine.eval(
          "local t = {}\n" +
            "xpcall(function() redis.call('set', 'k', {}) end, function(e)\n" +
            "  t[1] = type(e)\n" +
            "  if type(e) == 'table' then for k, v in pairs(e) do t[#t + 1] = tostring(k) .. '=' .. tostring(v) end\n" +
            "  else t[2] = e end\n" +
            "end)\n" +
            "return t",
        ),
      ),
      c.table ? ["table", `err=${argTypeError(c, "")}`] : ["string", argTypeError(c, "@user_script: 2")],
    );
    // The script goes on and the engine error is not reported.
    assert.deepEqual(engine.eval("pcall(redis.call, 'set', 'k', {})\nreturn redis.call('set', 'k', 'v')"), {
      ok: Buffer.from("OK"),
    });
    assertUsable(engine);
  });

  test(`engine errors (${c.label}): a caught global read reads like Redis`, async () => {
    const engine = await engineForCase(c);
    assert.equal(bulk(engine.eval("local ok, e = pcall(function() return nope end) return e")), globalReadError(1));
    assert.equal(
      bulk(engine.eval("local ok, e = pcall(function()\n\n  return nope\nend)\nreturn e")),
      globalReadError(3),
    );
    assert.deepEqual(strings(engine.eval("return {pcall(function() return nope end)}")).slice(1), [globalReadError(1)]);
    assert.equal(
      bulk(engine.eval("return select(2, xpcall(function() return nope end, function(e) return e end))")),
      globalReadError(1),
    );
    // The name is Redis's %s: a number key reads as its string form, and CR/LF
    // stay in the message the script sees (only the host's copy is sanitized).
    assert.equal(bulk(engine.eval("return select(2, pcall(function() return _G[42] end))")), globalReadError(1, "42"));
    assert.equal(
      bulk(engine.eval("return select(2, pcall(function() return _G['a\\r\\nb'] end))")),
      globalReadError(1, "a\r\nb"),
    );
    assertUsable(engine);
  });

  test(`engine errors (${c.label}): uncaught or rethrown unchanged, the host still gets the kind`, async () => {
    const engine = await engineForCase(c);
    assertEngineError(engine.eval("\nreturn redis.call('set', 'k', {})"), "command-arg-type", 2);
    assertEngineError(engine.eval("\n\nreturn nope"), "global-read", 3, "nope");
    const read = engine.eval("return _G['a\\r\\nb']");
    assertEngineError(read, "global-read", 1, "a\r\nb"); // CR/LF only in meta.name
    // error(e, 0) rethrows the very message.
    assertEngineError(
      engine.eval("local ok, e = pcall(redis.call, 'set', 'k', {})\nerror(e, 0)"),
      "command-arg-type",
      2,
    );
    assertEngineError(
      engine.eval("local ok, e = pcall(function() return nope end)\nerror(e, 0)"),
      "global-read",
      2,
      "nope",
    );
    // The error table an xpcall handler got, rethrown, is the engine's too.
    const table = engine.eval(
      "local err\nxpcall(function() redis.call('set', 'k', {}) end, function(e) err = e end)\nerror(err)",
    );
    if (c.table) {
      assertEngineError(table, "command-arg-type", 3);
    } else {
      // Redis 6.2 raises a string, which error() prefixes with a position.
      assertNotEngineError(table, "ERR", `user_script:3: ${argTypeError(c, "@user_script: 2")}`, 3);
    }
    // error(e) raises a new error: the position-prefixed message, reported
    // as an ordinary string error, as Redis reports it.
    assertNotEngineError(
      engine.eval("local ok, e = pcall(redis.call, 'set', 'k', {})\nerror(e)"),
      "ERR",
      `user_script:2: ${argTypeError(c, "=[C]: -1")}`,
      2,
    );
    assertNotEngineError(
      engine.eval("local ok, e = pcall(function() return nope end)\nerror(e)"),
      "ERR",
      `user_script:2: ${globalReadError(1)}`,
      2,
    );
    // So is any later error.
    assertNotEngineError(engine.eval("pcall(function() return nope end)\nerror('boom', 0)"), "ERR", "boom", 2);
    if (c.table) {
      // The real error table with its `err` changed is the script's own error,
      // reported with its message as Redis does (-ERR hacked, -ERR unknown
      // error, -42).
      const changed = (assignment: string) =>
        engine.eval(
          "local e\nxpcall(function() redis.call('set', 'k', {}) end, function(x) e = x end)\n" +
            `${assignment}\nerror(e, 0)`,
        );
      assertNotEngineError(changed("e.err = 'ERR hacked'"), "ERR", "hacked", 4);
      assertNotEngineError(changed("e.err = nil"), "ERR", "unknown error", 4);
      assertNotEngineError(changed("e.err = 42"), undefined, "42", 4);
      // Other fields do not matter: its message is still the engine's.
      assertEngineError(changed("e.extra = 1"), "command-arg-type", 4);
    }
    assertUsable(engine);
  });

  test(`engine errors (${c.label}): the globals handler checks its arguments like Redis`, async () => {
    const engine = await engineForCase(c);
    const badKey = "Second argument to luaProtectedTableError must be a string or number";
    const badCount = "Wrong number of arguments to luaProtectedTableError";
    // A key that is neither a string nor a number: Redis's argument error, an
    // ordinary one, caught or not.
    assert.equal(bulk(engine.eval("return select(2, pcall(function() return _G[true] end))")), `user_script:1: ${badKey}`);
    assertNotEngineError(engine.eval("\nreturn _G[true]"), "ERR", `user_script:2: ${badKey}`, 2);
    // Called directly with the wrong number of arguments.
    assert.equal(bulk(engine.eval("return select(2, pcall(getmetatable(_G).__index))")), badCount);
    assertNotEngineError(
      engine.eval("return getmetatable(_G).__index(_G, 'x', 'y')"),
      "ERR",
      `user_script:1: ${badCount}`,
      1,
    );
    // A name with a NUL byte: the message stops there (Redis's %s), the name
    // the host gets does not.
    assert.equal(
      bulk(engine.eval("return select(2, pcall(function() return _G['a\\0b'] end))")),
      globalReadError(1, "a"),
    );
    assertEngineError(engine.eval("return _G['a\\0b']"), "global-read", 1, "a\0b");
    assertUsable(engine);
  });

  test(`engine errors (${c.label}): Redis's wording raised by the script is not an engine error`, async () => {
    const failing: RedisHost = {
      ...host,
      redisCall(args) {
        return args[0]?.toString("utf8") === "fail" ? { err: args[1] ?? Buffer.alloc(0) } : { ok: Buffer.from("OK") };
      },
    };
    const engine = await engineForCase(c, failing);
    const argType = argTypeError(c, "=[C]: -1");
    const lua = (text: string) => JSON.stringify(text);
    // With no engine error in the eval, the exact text is only text.
    assertNotEngineError(engine.eval(`error(${lua(argType)}, 0)`), "ERR", argType);
    assertNotEngineError(engine.eval(`error(${lua(globalReadError(1))}, 0)`), "ERR", globalReadError(1));
    // A lookalike error table is never the engine's, even after a real one:
    // only the very table raised is.
    if (c.table) {
      assertNotEngineError(
        engine.eval(`pcall(redis.call, 'set', 'k', {})\nerror({err=${lua(argType)}})`),
        "ERR",
        argType.replace(/^ERR /, ""),
        2,
      );
      assertNotEngineError(
        engine.eval(`pcall(redis.call, 'set', 'k', {})\nredis.call('fail', ${lua(argType)})`),
        "ERR",
        argType.replace(/^ERR /, ""),
        2,
      );
    }
    // The very message the engine raised in this eval, raised again as a
    // string, is indistinguishable from rethrowing it: reported as the engine's.
    assertEngineError(
      engine.eval(`pcall(function() return nope end)\nerror(${lua(globalReadError(1))}, 0)`),
      "global-read",
      2,
      "nope",
    );
    // Never one from a previous eval.
    engine.eval("return nope");
    assertNotEngineError(engine.eval(`error(${lua(globalReadError(1))}, 0)`), "ERR", globalReadError(1));
    assertUsable(engine);
  });
}

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

// =============================================================================
// A script's string error keeps a leading ERR; the engine's own errors are
// never "ERR ERR" (#93). redis.sha1hex arity (#95).
// =============================================================================

// Checked against Redis 6.2.24, 7.0.15, 7.4.11, 8.0.6 and Valkey 8.0.11, 9.0.6
// (EVAL <script> 0).
const WORDING_PROFILES: CompatProfile[] = ["redis-6.2", "redis-7.0", "redis-8.0", "valkey-9.0"];

/** A host reply nested too deeply for redis.call to decode. */
function deepReply(depth: number): ReplyValue {
  let reply: ReplyValue = Buffer.from("leaf");
  for (let i = 0; i < depth; i += 1) {
    reply = [reply];
  }
  return reply;
}

for (const profile of WORDING_PROFILES) {
  const v62 = profile === "redis-6.2";
  /** A caught engine error: ERR-coded in the Redis 7 model, bare in Redis 6.2's. */
  const caught = (message: string) => Buffer.from(v62 ? message : `ERR ${message}`);

  test(`script errors (${profile}): an uncaught string error keeps its whole message (#93)`, async () => {
    const engine = await engineFor(profile);
    // Redis 7.0+ / Valkey: "-ERR ERR x script: ..."; Redis 6.2:
    // "-ERR Error running script (...): @user_script:1: ERR x".
    assertErr(engine.eval("error('ERR x',0)"), "ERR", "ERR x", 1);
    // "-ERR x script: ..." / "... @user_script:1: x".
    assertErr(engine.eval("error('x',0)"), "ERR", "x", 1);
    // "-ERR WRONGTYPE x script: ..." / "... @user_script:1: WRONGTYPE x".
    assertErr(engine.eval("error('WRONGTYPE x',0)"), "ERR", "WRONGTYPE x", 1);
    assertErr(engine.eval("\nerror('ERR x')"), "ERR", "user_script:2: ERR x", 2);
    // pcall is not affected: it returns the string as raised, as in Redis.
    assert.deepEqual(engine.eval("return {pcall(error, 'ERR x', 0)}"), [null, Buffer.from("ERR x")]);
    assertUsable(engine);
  });

  test(`script errors (${profile}): redis.sha1hex takes exactly one argument (#95)`, async () => {
    const engine = await engineFor(profile);
    // Redis 7.0+ / Valkey: "-ERR wrong number of arguments script: ...";
    // Redis 6.2: "... @user_script:1: wrong number of arguments".
    assertErr(engine.eval("return redis.sha1hex()"), "ERR", "wrong number of arguments", 1);
    assertErr(engine.eval("return redis.sha1hex('a','b')"), "ERR", "wrong number of arguments", 1);
    assertErr(engine.eval("\nreturn redis.sha1hex('a', nil)"), "ERR", "wrong number of arguments", 2);
    // Caught: "ERR wrong number of arguments" in Redis 7.0+ / Valkey; in Redis
    // 6.2 no code and no "user_script:N:" position.
    for (const script of [
      "local ok,e = pcall(redis.sha1hex) return tostring(e)",
      "local ok,e = pcall(redis.sha1hex, 'a', 'b') return tostring(e)",
      "local ok,e = pcall(function() return redis.sha1hex() end) return tostring(e)",
    ]) {
      assert.deepEqual(engine.eval(script), caught("wrong number of arguments"), script);
    }
    const xpcallType = "return select(2, xpcall(function() redis.sha1hex() end, function(e) return type(e) end))";
    assert.equal((engine.eval(xpcallType) as Buffer).toString(), v62 ? "string" : "table");
    // One argument still hashes, a number through its string form.
    assert.deepEqual(engine.eval("return redis.sha1hex('a')"), Buffer.from("86f7e437faa5a7fce15d1ddcb9eaeaea377667b8"));
    assert.deepEqual(engine.eval("return redis.sha1hex(1)"), Buffer.from("356a192b7913b04c54574d18c28d46e6395428ab"));
    // A value with no string form hashes as the empty string: Redis reads it
    // with lua_tolstring, which gives NULL and length 0.
    for (const arg of ["nil", "{}", "true", "false", "function() end"]) {
      assert.deepEqual(
        engine.eval(`return redis.sha1hex(${arg})`),
        Buffer.from("da39a3ee5e6b4b0d3255bfef95601890afd80709"),
        arg,
      );
    }
    assertUsable(engine);
  });

  test(`script errors (${profile}): the engine's own errors are not reported as ERR ERR (#93)`, async () => {
    const engine = (await load({ profile, limits: { maxFuel: 100_000 } })).create({
      ...host,
      redisCall(args, ctx) {
        return args[0]?.toString("utf8") === "deep" ? deepReply(1500) : host.redisCall(args, ctx);
      },
    });
    // A host reply too deep to decode.
    assertErr(engine.eval("return redis.call('deep')"), "ERR", "reached lua stack limit", 1);
    assertErr(engine.eval("\nreturn redis.pcall('deep')"), "ERR", "reached lua stack limit", 2);
    assert.deepEqual(engine.eval("return select(2, pcall(redis.call, 'deep'))"), caught("reached lua stack limit"));
    // An error table with no string err (luaExtractErrorInformation's fallback).
    assertErr(engine.eval("error({})"), "ERR", "unknown error", 1);
    // The fuel kill.
    assertErr(engine.eval("while true do end"), "ERR", "Script killed by fuel limit", 1);
    // The redis.* argument errors.
    assertErr(engine.eval("redis.setresp(4)"), "ERR", "RESP version must be 2 or 3.", 1);
    const debugLevel = profile === "redis-6.2" || profile === "redis-7.0";
    assertErr(engine.eval("redis.log(9, 'x')"), "ERR", debugLevel ? "Invalid debug level." : "Invalid log level.", 1);
    assertUsable(engine);
  });
}
