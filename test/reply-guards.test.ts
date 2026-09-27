/**
 * Guards on the reply conversions between Lua and the host:
 * - deep / cyclic script return values fail with "reached lua stack limit"
 *   instead of hanging the host (#35);
 * - deeply nested host replies fail cleanly inside redis.call (#50);
 * - out-of-range Lua numbers convert to integer replies like Redis on x86-64 (#46).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.js";
import type { ReplyValue, RedisHost } from "../src/types.js";

// Mirrors REDIS_REPLY_MAX_DEPTH in wasm/src/redis_api.h.
const MAX_DEPTH = 1000;
const INT64_MIN = -9223372036854775808n;

function nestedArray(depth: number): ReplyValue {
  let value: ReplyValue = 1;
  for (let i = 0; i < depth; i++) {
    value = [value];
  }
  return value;
}

function arrayDepth(value: ReplyValue): { depth: number; leaf: ReplyValue } {
  let depth = 0;
  while (Array.isArray(value)) {
    depth++;
    value = value[0];
  }
  return { depth, leaf: value };
}

function hostReturning(reply: () => ReplyValue): RedisHost {
  return {
    redisCall: reply,
    redisPcall: reply,
    log() {}
  };
}

async function createEngine(host: RedisHost = hostReturning(() => null)) {
  const module = await load();
  return module.create(host);
}

function assertStackLimitError(result: ReplyValue) {
  assert.ok(result && typeof result === "object" && "err" in result, `expected an error reply, got ${String(result)}`);
  const { err, code } = result as { err: Buffer; code?: Buffer | string };
  assert.equal(err.toString(), "reached lua stack limit");
  assert.equal(String(code), "ERR");
}

// =============================================================================
// Script return value depth (#35)
// =============================================================================

test("reply guards: deeply nested return table replies with a stack limit error", async () => {
  const engine = await createEngine();
  const result = engine.eval("local v = 1 for i = 1, 100000 do v = {v} end return v");
  assertStackLimitError(result);
  // The engine stays usable afterwards.
  assert.equal(engine.eval("return 42"), 42);
});

test("reply guards: cyclic return table replies with a stack limit error", async () => {
  const engine = await createEngine();
  assertStackLimitError(engine.eval("local t = {} t[1] = t return t"));
  assert.equal(engine.eval("return 42"), 42);
});

test("reply guards: cyclic tables through map/set/nested arrays reply with a stack limit error", async () => {
  const engine = await createEngine();
  const scripts = [
    // {map=...} whose value refers back to the outer table
    "local t = {} t.map = {k = t} return t",
    // table used as its own map key
    "local t = {} t.map = {} t.map[t] = 1 return t",
    // {set=...} member refers back to the outer table
    "local t = {} t.set = {} t.set[t] = true return t",
    // cycle below a normal array element
    "local t = {} t[1] = 'a' t[2] = {t} return t"
  ];
  for (const script of scripts) {
    assertStackLimitError(engine.eval(script));
  }
  assert.equal(engine.eval("return 42"), 42);
});

test("reply guards: nesting up to the depth cap still encodes", async () => {
  const engine = await createEngine();
  const ok = engine.eval(`local v = 1 for i = 1, ${MAX_DEPTH} do v = {v} end return v`);
  assert.deepEqual(arrayDepth(ok), { depth: MAX_DEPTH, leaf: 1 });
  assertStackLimitError(engine.eval(`local v = 1 for i = 1, ${MAX_DEPTH + 1} do v = {v} end return v`));

  // Typed tables count one level per map/set entry, like arrays.
  const map = engine.eval(`local v = 1 for i = 1, ${MAX_DEPTH} do v = {map = {k = v}} end return v`);
  assert.ok(map && typeof map === "object" && "map" in map);
  assertStackLimitError(engine.eval(`local v = 1 for i = 1, ${MAX_DEPTH + 1} do v = {map = {k = v}} end return v`));
  assertStackLimitError(engine.eval(`local v = 1 for i = 1, ${MAX_DEPTH + 1} do v = {set = {[v] = true}} end return v`));
});

test("reply guards: wide and moderately nested replies are unaffected", async () => {
  const engine = await createEngine();
  const wide = engine.eval("local t = {} for i = 1, 10000 do t[i] = {i, {i}} end return t") as ReplyValue[];
  assert.equal(wide.length, 10000);
  assert.deepEqual(wide[9999], [10000, [10000]]);
  // A table referenced twice (not a cycle) is encoded twice.
  assert.deepEqual(engine.eval("local s = {1, 2} return {s, s}"), [[1, 2], [1, 2]]);
});

test("reply guards: stack limit error still applies with evalWithArgs", async () => {
  const engine = await createEngine();
  const result = engine.evalWithArgs("local t = {KEYS[1]} t[2] = t return t", [Buffer.from("k")], []);
  assertStackLimitError(result);
  assert.deepEqual(engine.evalWithArgs("return {KEYS[1], ARGV[1]}", [Buffer.from("k")], [Buffer.from("a")]), [
    Buffer.from("k"),
    Buffer.from("a")
  ]);
});

// =============================================================================
// Host reply depth (#50)
// =============================================================================

test("reply guards: deeply nested host reply raises a script error from redis.call", async () => {
  const engine = await createEngine(hostReturning(() => nestedArray(MAX_DEPTH + 500)));
  const result = engine.eval("return redis.call('DEEP')");
  assertStackLimitError(result);
  // redis.pcall raises the decoding error too (it is not a command error reply).
  assertStackLimitError(engine.eval("return redis.pcall('DEEP')"));
  // Catchable from Lua, and the engine keeps working afterwards.
  assert.deepEqual(engine.eval("local ok, err = pcall(redis.call, 'DEEP') return {tostring(ok), err}"), [
    Buffer.from("false"),
    Buffer.from("ERR reached lua stack limit")
  ]);
  assert.equal(engine.eval("return 42"), 42);
});

test("reply guards: host reply nested up to the depth cap decodes", async () => {
  const engine = await createEngine(hostReturning(() => nestedArray(MAX_DEPTH)));
  assert.deepEqual(
    engine.eval("local v = redis.call('DEEP') local d = 0 while type(v) == 'table' do d = d + 1 v = v[1] end return {d, v}"),
    [MAX_DEPTH, 1]
  );
});

// =============================================================================
// Number -> integer reply conversion (#46)
// =============================================================================

test("reply guards: out-of-range numbers become INT64_MIN like Redis on x86-64", async () => {
  const engine = await createEngine();
  for (const expr of ["1e20", "-1e20", "0/0", "math.huge", "-math.huge", "2^63", "-(2^64)"]) {
    assert.equal(engine.eval(`return ${expr}`), INT64_MIN, `return ${expr}`);
  }
  // Also inside arrays.
  assert.deepEqual(engine.eval("return {1, 0/0, math.huge}"), [1, INT64_MIN, INT64_MIN]);
});

test("reply guards: in-range numbers are truncated as before", async () => {
  const engine = await createEngine();
  assert.equal(engine.eval("return 3.7"), 3);
  assert.equal(engine.eval("return -3.7"), -3);
  assert.equal(engine.eval("return -2^63"), INT64_MIN);
  assert.equal(engine.eval("return 2^62"), 4611686018427387904n);
  assert.equal(engine.eval("return 2^63 - 1024"), 9223372036854774784n);
  assert.equal(engine.eval("return 9007199254740991"), Number.MAX_SAFE_INTEGER);
  assert.equal(engine.eval("return -9007199254740991"), Number.MIN_SAFE_INTEGER);
});
