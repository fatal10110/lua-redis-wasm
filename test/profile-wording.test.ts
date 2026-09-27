/**
 * Profile-specific redis.error_reply / redis.log behavior and wording (#67),
 * checked against each version's source:
 *
 * - Redis 6.2 (src/scripting.c): error_reply returns its argument unchanged,
 *   a bad call returns "<source>: <line>: wrong number or type of arguments"
 *   (luaPushError), and redis.log raises bare strings with no ERR code;
 * - Redis 7.0+ / Valkey (src/script_lua.c): error_reply goes through
 *   luaPushErrorBuff and redis.log errors get the ERR code (both came with the
 *   Redis 7 error model, so they follow `compat.tableErrors`);
 * - "Invalid debug level." up to Redis 7.2, "Invalid log level." from Redis
 *   7.4 and Valkey 8.0;
 * - Valkey 8.0+ names "server.log()" in the arity error.
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

for (const [profile, w] of PROFILES) {
  const name = profile ?? "default";

  test(`profile wording (${name}): redis.error_reply`, async () => {
    assertErrorReply(await engineFor(profile), w);
  });

  test(`profile wording (${name}): redis.log argument errors`, async () => {
    const engine = await engineFor(profile);
    assertLogErrors(engine, w);
    // Uncaught, the host gets the message with the generic code and the line.
    const m = logMessages(w);
    assertErr(engine.eval("\nredis.log()"), m.arity, "ERR", 2);
    assertErr(engine.eval("\nredis.log(4, 'msg')"), m.level, "ERR", 2);
    assertErr(engine.eval("\nredis.log('x', 'msg')"), m.type, "ERR", 2);
  });
}

test("profile wording: server.log shares the Valkey wording", async () => {
  const engine = await engineFor("valkey-8.0");
  assert.equal(
    text(engine.eval("local ok, e = pcall(server.log) return e")),
    "ERR server.log() requires two arguments or more.",
  );
});

test("profile wording: tableErrors decides the error_reply rule and the ERR code", async () => {
  // Wording stays with the profile; the error model follows the override.
  const on = await engineFor("redis-6.2", { tableErrors: true });
  assertErrorReply(on, { table: true, debugLevel: true, serverLog: false });
  assertLogErrors(on, { table: true, debugLevel: true, serverLog: false });

  const off = await engineFor("redis-8.0", { tableErrors: false });
  assertErrorReply(off, { table: false, debugLevel: false, serverLog: false });
  assertLogErrors(off, { table: false, debugLevel: false, serverLog: false });

  // serverAlias does not change the wording: it follows the profile only.
  const noAlias = await engineFor("valkey-8.0", { serverAlias: false });
  assertLogErrors(noAlias, { table: true, debugLevel: false, serverLog: true });
  const alias = await engineFor("redis-8.0", { serverAlias: true });
  assertLogErrors(alias, { table: true, debugLevel: false, serverLog: false });
});
