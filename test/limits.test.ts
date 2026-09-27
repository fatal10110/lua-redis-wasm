/**
 * EngineLimits: maxReplyBytes (enforced while the reply is encoded),
 * maxArgBytes and limit validation. All limits
 * are enforced by the WASM runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, LuaEngine } from "../src/index.js";
import type { EngineLimits, RedisHost, ReplyValue } from "../src/types.js";

type ErrReply = { err: Buffer; code?: Buffer; meta?: { line: number; sha: string } };

const REPLY_LIMIT = "reply exceeds configured limit";
const ARG_LIMIT = "KEYS/ARGV exceeds configured limit";

function host(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall: () => ({ ok: Buffer.from("OK") }),
    redisPcall: () => ({ ok: Buffer.from("OK") }),
    log: () => {},
    ...overrides,
  };
}

async function engineWith(limits: EngineLimits, overrides: Partial<RedisHost> = {}): Promise<LuaEngine> {
  return (await load({ limits })).create(host(overrides));
}

function assertErr(value: ReplyValue, message: string | RegExp): ErrReply {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  const reply = value as ErrReply;
  if (typeof message === "string") {
    assert.equal(reply.err.toString("utf8"), message);
  } else {
    assert.match(reply.err.toString("utf8"), message);
  }
  return reply;
}

function assertUsable(engine: LuaEngine): void {
  assert.equal(engine.eval("return 1 + 1"), 2);
  assert.deepEqual(engine.evalWithArgs("return {KEYS[1], ARGV[1]}", ["k"], ["a"]), [
    Buffer.from("k"),
    Buffer.from("a"),
  ]);
}

function sha1(script: string): string {
  return createHash("sha1").update(script).digest("hex");
}

// A small Lua value that expands into 2^n leaf arrays when encoded: every
// reference to the shared subtable is encoded again.
const shared = (n: number) => `local t = {} for i = 1, ${n} do t = {t, t} end return t`;

// =============================================================================
// maxReplyBytes (#69, #53)
// =============================================================================

test("maxReplyBytes: a shared-subtable reply fails at the limit, quickly (#69)", async () => {
  const engine = await engineWith({ maxReplyBytes: 1000 });
  const started = Date.now();
  assertErr(engine.eval(shared(21)), REPLY_LIMIT);
  assertErr(engine.eval(shared(30)), REPLY_LIMIT);
  // The encoder stops at the first write past 1000 bytes instead of building
  // millions of arrays first (which took ~0.75 s and then aborted with OOM).
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
  assertUsable(engine);
  assert.equal((engine.eval("return {1, 2, 3}") as unknown[]).length, 3);
});

test("maxReplyBytes: a reply of exactly the limit passes, one byte more fails", async () => {
  // A bulk reply is a 5-byte header plus the payload.
  const engine = await engineWith({ maxReplyBytes: 64 });
  assert.deepEqual(engine.eval("return string.rep('x', 59)"), Buffer.alloc(59, "x"));
  assertErr(engine.eval("return string.rep('x', 60)"), REPLY_LIMIT);

  // Nested: array header (5) + two integers (13 each) = 31 bytes.
  const nested = await engineWith({ maxReplyBytes: 31 });
  assert.deepEqual(nested.eval("return {1, 2}"), [1, 2]);
  const over = await engineWith({ maxReplyBytes: 30 });
  assertErr(over.eval("return {1, 2}"), REPLY_LIMIT);
  assertUsable(over);
});

test("maxReplyBytes: applies to returned {err=} and {ok=} tables but not to script errors", async () => {
  const engine = await engineWith({ maxReplyBytes: 16 });
  assertErr(engine.eval("return {err = 'ERR ' .. string.rep('e', 40)}"), REPLY_LIMIT);
  assertErr(engine.eval("return {ok = string.rep('o', 40)}"), REPLY_LIMIT);
  // A script-aborting error is reported in full, whatever its size.
  const reply = assertErr(engine.eval(`error('${"z".repeat(100)}')`), /z{100}/);
  assert.ok(reply.meta);
});

test("maxReplyBytes: a too-deep reply reports whichever limit it reaches first", async () => {
  const cyclic = "local t = {} t[1] = t return t";
  // 1000 levels of 5-byte array headers fit in 10 000 bytes: the depth guard fires.
  const roomy = await engineWith({ maxReplyBytes: 10_000 });
  assertErr(roomy.eval(cyclic), /reached lua stack limit/);
  assertUsable(roomy);
  // With 1000 bytes the reply limit is reached first.
  const tight = await engineWith({ maxReplyBytes: 1000 });
  assertErr(tight.eval(cyclic), REPLY_LIMIT);
  // And a depth-guard error reply larger than the limit is itself refused.
  const tiny = await engineWith({ maxReplyBytes: 8 });
  assertErr(tiny.eval(cyclic), REPLY_LIMIT);
  assertUsable(tight);
});

test("maxReplyBytes: without a limit, a reply too large for the heap is an error, not an abort", async () => {
  const engine = (await load()).createStandalone();
  assertErr(engine.eval(shared(21)), "reply encoding failed");
  assertUsable(engine);
});

test("maxReplyBytes: host replies to redis.call are not limited", async () => {
  const big = Buffer.alloc(4096, "h");
  const engine = await engineWith({ maxReplyBytes: 64 }, { redisCall: () => big });
  assert.equal(engine.eval("return #redis.call('GET', 'k')"), 4096);
});

// =============================================================================
// maxArgBytes (#53: enforced in WASM only)
// =============================================================================

test("maxArgBytes: the encoded KEYS/ARGV size is limited, inclusively", async () => {
  // count (4) + one entry: length (4) + 2 bytes = 10 bytes.
  const exact = await engineWith({ maxArgBytes: 10 });
  assert.deepEqual(exact.evalWithArgs("return KEYS[1]", ["ab"], []), Buffer.from("ab"));
  assertErr(exact.evalWithArgs("return KEYS[1]", ["abc"], []), ARG_LIMIT);
  assertErr(exact.evalWithArgs("return 1", ["a"], ["b"]), ARG_LIMIT);
  // eval (no KEYS/ARGV) is unaffected.
  assert.equal(exact.eval("return 1"), 1);
  assert.deepEqual(exact.evalWithArgs("return {KEYS[1]}", ["k"], []), [Buffer.from("k")]);
});

// =============================================================================
// Limit validation
// =============================================================================

test("limits: values that are not non-negative integers are rejected by load()", async () => {
  for (const limits of [
    { maxFuel: -1 },
    { maxFuel: Number.NaN },
    { maxReplyBytes: -5 },
    { maxArgBytes: "10" as unknown as number },
    // A fraction below 1 must not round down to 0 (no limit).
    { maxReplyBytes: 0.5 },
    { maxArgBytes: 0.9 },
    { maxFuel: 1000.5 },
    { maxArgBytes: Infinity },
  ]) {
    await assert.rejects(load({ limits }), RangeError, JSON.stringify(limits));
  }
});

test("limits: values beyond u32 saturate instead of wrapping", async () => {
  // 2^32 + 5 would wrap to 5 bytes.
  const engine = await engineWith({ maxArgBytes: 2 ** 32 + 5, maxReplyBytes: 2 ** 40 });
  assert.deepEqual(engine.evalWithArgs("return ARGV[1]", [], ["abcdef"]), Buffer.from("abcdef"));
  assert.deepEqual(engine.getLimits(), { maxArgBytes: 2 ** 32 + 5, maxReplyBytes: 2 ** 40 });
});

// =============================================================================
// Script SHA1 in error metadata (#57)
// =============================================================================

test("script errors carry the script's SHA1", async () => {
  const engine = await engineWith({});
  const script = "local x = 1\nerror('boom')";
  assert.equal(assertErr(engine.eval(script), /boom/).meta?.sha, sha1(script));
  assert.equal(assertErr(engine.evalWithArgs(script, ["k"], ["a"]), /boom/).meta?.sha, sha1(script));
  const syntax = "return +";
  assert.equal(assertErr(engine.eval(Buffer.from(syntax)), /user_script/).meta?.sha, sha1(syntax));
  // Error values the script returns are not decorated.
  assert.equal((engine.eval("return redis.error_reply('nope')") as ErrReply).meta, undefined);
});
