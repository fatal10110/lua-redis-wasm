/**
 * Profile-specific redis.error_reply / redis.log behavior and wording (#67),
 * checked against each version's source:
 *
 * - Redis 6.2 (src/scripting.c): error_reply returns its argument unchanged,
 *   a bad call returns "<source>: <line>: wrong number or type of arguments"
 *   (luaPushError), and redis.log / redis.setresp raise bare strings with no
 *   ERR code;
 * - Redis 7.0+ / Valkey (src/script_lua.c): error_reply goes through
 *   luaPushErrorBuff and redis.log / redis.setresp errors get the ERR code (both came with the
 *   Redis 7 error model, so they follow `compat.tableErrors`);
 * - "Invalid debug level." up to Redis 7.2, "Invalid log level." from Redis
 *   7.4 and Valkey 8.0;
 * - Valkey 8.0+ names "server.log()" in the arity error;
 * - redis.status_reply shares error_reply's argument check in every version
 *   (luaRedisReturnSingleFieldTable): a bad call returns the same error table
 *   (#82);
 * - redis.pcall with an argument that is not a string or number returns the
 *   error table instead of raising (luaRedisGenericCommand): "Lua redis()
 *   command arguments must be strings or integers" positioned and code-less in
 *   Redis 6.2, "ERR Lua redis lib command arguments ..." in Redis 7.0-8.0 and
 *   "ERR Command arguments ..." in Valkey 8.0. redis.call still raises the
 *   command-arg-type engine error (#84).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaEngine } from "../src/index.js";
import type { CompatOverrides, CompatProfile, RedisHost, ReplyValue } from "../src/types.js";

type ErrReply = { err: Buffer; code?: Buffer; meta?: { line: number } };

const host: RedisHost = {
  redisCall() {
    return { ok: Buffer.from("OK") };
  },
  redisPcall() {
    return { ok: Buffer.from("OK") };
  },
  log() {},
};

async function engineFor(profile?: CompatProfile, compat?: CompatOverrides): Promise<LuaEngine> {
  return (await load({ profile, compat })).create(host);
}

function text(value: ReplyValue): string {
  assert.ok(Buffer.isBuffer(value), `expected a bulk string, got ${String(value)}`);
  return value.toString("utf8");
}

function assertErr(value: ReplyValue, err: string, code: string | undefined, line?: number): void {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  const reply = value as ErrReply;
  assert.equal(reply.err.toString("utf8"), err);
  assert.equal(reply.code?.toString("utf8"), code);
  if (line !== undefined) {
    assert.equal(reply.meta?.line, line);
  }
}

type Wording = {
  /** Redis 7 error model: normalized error_reply, ERR-coded redis.log errors. */
  table: boolean;
  /** "Invalid debug level." (Redis <= 7.2) instead of "Invalid log level.". */
  debugLevel: boolean;
  /** "server.log()" (Valkey 8.0+) instead of "redis.log()" in the arity error. */
  serverLog: boolean;
};

const PROFILES: Array<[CompatProfile | undefined, Wording]> = [
  [undefined, { table: true, debugLevel: false, serverLog: false }],
  ["redis-6.2", { table: false, debugLevel: true, serverLog: false }],
  ["redis-7.0", { table: true, debugLevel: true, serverLog: false }],
  ["redis-7.2", { table: true, debugLevel: true, serverLog: false }],
  ["redis-7.4", { table: true, debugLevel: false, serverLog: false }],
  ["redis-8.0", { table: true, debugLevel: false, serverLog: false }],
  ["valkey-8.0", { table: true, debugLevel: false, serverLog: true }],
  ["valkey-9.0", { table: true, debugLevel: false, serverLog: true }],
];

function logMessages(w: Wording): { arity: string; level: string; type: string } {
  return {
    arity: `${w.serverLog ? "server" : "redis"}.log() requires two arguments or more.`,
    level: w.debugLevel ? "Invalid debug level." : "Invalid log level.",
    type: "First argument must be a number (log level).",
  };
}

// Caught with pcall, a redis.log error is the message itself, ERR-coded only
// in the Redis 7 error model.
function assertLogErrors(engine: LuaEngine, w: Wording): void {
  const m = logMessages(w);
  const prefix = w.table ? "ERR " : "";
  const caught = (args: string) => text(engine.eval(`local ok, e = pcall(redis.log${args}) return e`));
  assert.equal(caught(""), prefix + m.arity);
  assert.equal(caught(", redis.LOG_WARNING"), prefix + m.arity);
  assert.equal(caught(", 'x', 'msg'"), prefix + m.type);
  assert.equal(caught(", -1, 'msg'"), prefix + m.level);
  assert.equal(caught(", 4, 'msg'"), prefix + m.level);
  assert.equal(caught(", 0/0, 'msg'"), prefix + m.level);
  // redis.setresp's version error follows the same rule (luaSetResp).
  assert.equal(text(engine.eval("local ok, e = pcall(redis.setresp, 4) return e")), `${prefix}RESP version must be 2 or 3.`);
}

function assertErrorReply(engine: LuaEngine, w: Wording): void {
  const field = (arg: string) => text(engine.eval(`return redis.error_reply(${arg}).err`));
  if (w.table) {
    assert.equal(field("'My Error'"), "My Error");
    assert.equal(field("'-ERR x'"), "ERR x");
    assert.equal(field("'word'"), "ERR word");
    assert.equal(field("'CODE msg\\r\\n'"), "CODE msg");
    assert.equal(field("'a\\0b c'"), "ERR a");
    assert.equal(field(""), "ERR wrong number or type of arguments");
    assert.equal(field("1"), "ERR wrong number or type of arguments");
    assert.equal(
      text(engine.eval("return select(2, pcall(redis.error_reply)).err")),
      "ERR wrong number or type of arguments",
    );
    assertErr(engine.eval("return redis.error_reply('word')"), "word", "ERR");
    assertErr(engine.eval("return redis.error_reply('-ERR x')"), "x", "ERR");
  } else {
    // Redis 6.2: the argument is returned unchanged, binary-safe.
    assert.equal(field("'My Error'"), "My Error");
    assert.equal(field("'-ERR x'"), "-ERR x");
    assert.equal(field("'word'"), "word");
    assert.equal(field("'CODE msg\\r\\n'"), "CODE msg\r\n");
    assert.deepEqual(engine.eval("return redis.error_reply('a\\0b c').err"), Buffer.from("a\0b c"));
    // luaPushError positions a bad call at its caller, with no code.
    assert.equal(field(""), "@user_script: 1: wrong number or type of arguments");
    assert.equal(
      text(engine.eval("\n\nreturn redis.error_reply('a', 'b').err")),
      "@user_script: 3: wrong number or type of arguments",
    );
    assert.equal(
      text(engine.eval("return select(2, pcall(redis.error_reply)).err")),
      "=[C]: -1: wrong number or type of arguments",
    );
    // Returned, the string is the error reply as is (Redis 6.2 sends "-<err>").
    assertErr(engine.eval("return redis.error_reply('word')"), "word", undefined);
    assertErr(engine.eval("return redis.error_reply('-ERR x')"), "-ERR x", undefined);
  }
  // Either way an uppercase leading token is the code on the host side.
  assertErr(engine.eval("return redis.error_reply('MY custom')"), "custom", "MY");
}

const BAD_REPLY_CALLS = ["", "5", "nil", "{}", "true", "'a', 'b'", "'a', nil"];

function assertStatusReply(engine: LuaEngine, w: Wording): void {
  assert.equal(text(engine.eval("return redis.status_reply('PONG').ok")), "PONG");
  assert.deepEqual(engine.eval("return redis.status_reply('a\\0b').ok"), Buffer.from("a\0b"));
  assert.deepEqual(engine.eval("return redis.status_reply('PONG')"), { ok: Buffer.from("PONG") });
  // A bad call returns (does not raise) the error table error_reply gives for
  // one, with no ok field: a number is not converted, extra arguments count.
  const bad = w.table ? "ERR wrong number or type of arguments" : "@user_script: 1: wrong number or type of arguments";
  for (const args of BAD_REPLY_CALLS) {
    const call = `redis.status_reply(${args})`;
    assert.deepEqual(
      strings(engine.eval(`local r = ${call} return {type(r), tostring(r.ok), r.err}`)),
      ["table", "nil", bad],
      call,
    );
  }
  if (w.table) {
    assert.equal(text(engine.eval("\n\nreturn redis.status_reply(5).err")), bad);
    assert.equal(text(engine.eval("return select(2, pcall(redis.status_reply)).err")), bad);
    // Returned, it is an error reply with the ERR code.
    assertErr(engine.eval("return redis.status_reply(5)"), "wrong number or type of arguments", "ERR");
  } else {
    assert.equal(
      text(engine.eval("\n\nreturn redis.status_reply(5).err")),
      "@user_script: 3: wrong number or type of arguments",
    );
    assert.equal(
      text(engine.eval("return select(2, pcall(redis.status_reply)).err")),
      "=[C]: -1: wrong number or type of arguments",
    );
    assertErr(engine.eval("return redis.status_reply(5)"), bad, undefined);
  }
  // error_reply agrees on the bad calls in both models.
  for (const args of BAD_REPLY_CALLS) {
    assert.equal(text(engine.eval(`return redis.error_reply(${args}).err`)), bad, `redis.error_reply(${args})`);
  }
}

function argTypeMessage(w: Wording): string {
  if (!w.table) {
    return "Lua redis() command arguments must be strings or integers";
  }
  return w.serverLog
    ? "Command arguments must be strings or integers"
    : "Lua redis lib command arguments must be strings or integers";
}

// redis.pcall returns the error table for a bad argument; redis.call raises
// the command-arg-type engine error the host words.
function assertPcallArgType(engine: LuaEngine, w: Wording): void {
  const msg = argTypeMessage(w);
  const at = (where: string) => (w.table ? `ERR ${msg}` : `${where}: ${msg}`);
  for (const args of ["{}", "'set', 'k', {}", "'set', 'k', true", "'set', nil, 'v'", "'set', 'k', function() end"]) {
    const call = `redis.pcall(${args})`;
    assert.deepEqual(
      strings(engine.eval(`local e = ${call} return {type(e), e.err, tostring(e.ignore_error_stats_update)}`)),
      ["table", at("@user_script: 1"), "nil"],
      call,
    );
  }
  assert.equal(text(engine.eval("\n\nreturn redis.pcall('set', 'k', {}).err")), at("@user_script: 3"));
  assert.equal(text(engine.eval("return select(2, pcall(redis.pcall, 'set', 'k', {})).err")), at("=[C]: -1"));
  // The script goes on after it.
  assert.deepEqual(engine.eval("local e = redis.pcall('set', 'k', {})\nreturn redis.call('set', 'k', 'v')"), {
    ok: Buffer.from("OK"),
  });
  // Returned or rethrown, it is an ordinary error: no engine kind.
  const returned = engine.eval("return redis.pcall('set', 'k', {})") as ErrReply & { meta?: { kind?: string } };
  if (w.table) {
    assertErr(returned, msg, "ERR");
  } else {
    assertErr(returned, at("@user_script: 1"), undefined);
  }
  assert.equal(returned.meta?.kind, undefined);
  const rethrown = engine.eval("local e = redis.pcall('set', 'k', {})\nerror(e)") as ErrReply & {
    meta?: { kind?: string };
  };
  assertErr(rethrown, w.table ? msg : at("@user_script: 1"), "ERR", 2);
  assert.equal(rethrown.meta?.kind, undefined);
  // redis.call keeps raising the engine error.
  const raised = engine.eval("\nredis.call('set', 'k', {})") as ErrReply & { meta?: { kind?: string } };
  assertErr(raised, "command-arg-type", "ERR", 2);
  assert.equal(raised.meta?.kind, "command-arg-type");
  assert.equal(engine.eval("return 1 + 1"), 2);
}

function strings(value: ReplyValue): string[] {
  assert.ok(Array.isArray(value), `expected an array, got ${String(value)}`);
  return value.map((item) => (Buffer.isBuffer(item) ? item.toString("utf8") : String(item)));
}

for (const [profile, w] of PROFILES) {
  const name = profile ?? "default";

  test(`profile wording (${name}): redis.error_reply`, async () => {
    assertErrorReply(await engineFor(profile), w);
  });

  test(`profile wording (${name}): redis.status_reply argument checks (#82)`, async () => {
    assertStatusReply(await engineFor(profile), w);
  });

  test(`profile wording (${name}): redis.pcall returns the bad-argument error (#84)`, async () => {
    assertPcallArgType(await engineFor(profile), w);
  });

  test(`profile wording (${name}): redis.log argument errors`, async () => {
    const engine = await engineFor(profile);
    assertLogErrors(engine, w);
    // Uncaught, the host gets the message with the generic code and the line.
    const m = logMessages(w);
    assertErr(engine.eval("\nredis.log()"), m.arity, "ERR", 2);
    assertErr(engine.eval("\nredis.log(4, 'msg')"), m.level, "ERR", 2);
    assertErr(engine.eval("\nredis.log('x', 'msg')"), m.type, "ERR", 2);
    // A code-less string error (6.2) always has code ERR on the host side, its
    // first word is not the code: Redis 6.2 sends "-ERR Error running script
    // ..." (#83).
    assertErr(engine.eval("\nredis.setresp(4)"), "RESP version must be 2 or 3.", "ERR", 2);
  });
}

test("profile wording: server.log shares the Valkey wording", async () => {
  const engine = await engineFor("valkey-8.0");
  assert.equal(
    text(engine.eval("local ok, e = pcall(server.log) return e")),
    "ERR server.log() requires two arguments or more.",
  );
});

test("profile wording (redis-6.2): the setresp error is a code-less string", async () => {
  const engine = await engineFor("redis-6.2");
  assert.equal(
    text(engine.eval("return select(2, xpcall(function() redis.setresp(4) end, function(e) return type(e) .. ':' .. e end))")),
    "string:RESP version must be 2 or 3.",
  );
});

test("profile wording: tableErrors decides the error_reply rule and the ERR code", async () => {
  // Wording stays with the profile; the error model follows the override.
  const on = await engineFor("redis-6.2", { tableErrors: true });
  assertErrorReply(on, { table: true, debugLevel: true, serverLog: false });
  assertLogErrors(on, { table: true, debugLevel: true, serverLog: false });
  assertStatusReply(on, { table: true, debugLevel: true, serverLog: false });
  assertPcallArgType(on, { table: true, debugLevel: true, serverLog: false });

  const off = await engineFor("redis-8.0", { tableErrors: false });
  assertErrorReply(off, { table: false, debugLevel: false, serverLog: false });
  assertLogErrors(off, { table: false, debugLevel: false, serverLog: false });
  assertStatusReply(off, { table: false, debugLevel: false, serverLog: false });
  assertPcallArgType(off, { table: false, debugLevel: false, serverLog: false });
  // Without table errors the Redis 6.2 form and wording apply, Valkey too.
  assertPcallArgType(await engineFor("valkey-8.0", { tableErrors: false }), {
    table: false,
    debugLevel: false,
    serverLog: true,
  });

  // serverAlias does not change the wording: it follows the profile only.
  const noAlias = await engineFor("valkey-8.0", { serverAlias: false });
  assertLogErrors(noAlias, { table: true, debugLevel: false, serverLog: true });
  const alias = await engineFor("redis-8.0", { serverAlias: true });
  assertLogErrors(alias, { table: true, debugLevel: false, serverLog: false });
});
