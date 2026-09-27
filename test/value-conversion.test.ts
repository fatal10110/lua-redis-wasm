/**
 * Lua <-> Redis value conversions that must match Redis exactly:
 * - values with no reply type (function, coroutine, userdata) reply nil in
 *   place, at any depth, like luaReplyToRedisReply's `default: addReplyNull`
 *   (#66);
 * - redis.call/redis.pcall number arguments are formatted like Redis 7.4+'s
 *   luaArgsToRedisArgv (double2ll + ll2string, else fpconv_dtoa) (#68).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.js";
import type { ReplyValue, RedisHost } from "../src/types.js";

async function createEngine(host?: RedisHost) {
  const module = await load();
  return module.create(
    host ?? {
      redisCall: () => null,
      redisPcall: () => null,
      log() {}
    }
  );
}

// =============================================================================
// Unsupported return types reply nil (#66)
// =============================================================================

test("return: function, coroutine and userdata reply nil", async () => {
  const engine = await createEngine();
  assert.equal(engine.eval("return function() end"), null);
  assert.equal(engine.eval("return tostring"), null); // C function
  assert.equal(engine.eval("return coroutine.create(function() end)"), null);
  // cjson.null is a light userdata.
  assert.equal(engine.eval("return type(cjson.null)").toString(), "userdata");
  assert.equal(engine.eval("return cjson.null"), null);
});

test("return: unsupported array elements become nil in place", async () => {
  const engine = await createEngine();
  assert.deepEqual(engine.eval("return {1, function() end, 3}"), [1, null, 3]);
  assert.deepEqual(engine.eval("return {1, cjson.null, 3}"), [1, null, 3]);
  assert.deepEqual(engine.eval("return {function() end}"), [null]);
  assert.deepEqual(
    engine.eval("return {1, {2, coroutine.create(function() end)}, 'x'}"),
    [1, [2, null], Buffer.from("x")]
  );
  // A real nil still ends the array, like Redis (it stops at the first nil).
  assert.deepEqual(engine.eval("return {1, function() end, nil, 4}"), [1, null]);
});

test("return: unsupported values inside {map=} and {set=} become nil", async () => {
  const engine = await createEngine();
  const expected: Record<string, ReplyValue> = {
    map: { map: [[Buffer.from("a"), null]] },
    set: { set: [null] }
  };
  for (const prefix of ["", "redis.setresp(3) "]) {
    assert.deepEqual(engine.eval(`${prefix}return {map={a=function() end}}`), expected.map, prefix);
    assert.deepEqual(engine.eval(`${prefix}return {set={[function() end]=true}}`), expected.set, prefix);
    assert.deepEqual(
      engine.eval(`${prefix}return {map={a={1, cjson.null}}}`),
      { map: [[Buffer.from("a"), [1, null]]] },
      prefix
    );
  }
});

test("return: typed-table fields of an unsupported type are ignored like Redis", async () => {
  const engine = await createEngine();
  // Redis only honours err/ok/double/... fields of the right type; otherwise the
  // table is an (here empty) array.
  assert.deepEqual(engine.eval("return {err=function() end}"), []);
  assert.deepEqual(engine.eval("return {double=function() end}"), []);
});

test("return: a dropped extra value is not encoded, the first one is", async () => {
  const engine = await createEngine();
  assert.equal(engine.eval("return 5, function() end"), 5);
  assert.equal(engine.eval("return function() end, 5"), null);
});

// =============================================================================
// Number arguments to redis.call / redis.pcall (#68)
// =============================================================================

function capturingEngine() {
  const calls: string[][] = [];
  const handler = (args: Buffer[]): ReplyValue => {
    calls.push(args.map((a) => a.toString("latin1")));
    return null;
  };
  return createEngine({ redisCall: handler, redisPcall: handler, log() {} }).then((engine) => ({
    engine,
    calls
  }));
}

// Expected strings are what Redis 7.4+ sends: the same double2ll/fpconv_dtoa code.
const NUMBER_ARGS: [lua: string, expected: string][] = [
  ["3", "3"],
  ["-3", "-3"],
  ["0", "0"],
  ["-0.0", "0"],
  ["1.5", "1.5"],
  ["3.3", "3.3"],
  ["-3.3", "-3.3"],
  ["0.1+0.2", "0.30000000000000004"],
  ["1/3", "0.3333333333333333"],
  ["1e15", "1000000000000000"],
  ["1e-7", "1e-7"],
  ["0.000001", "0.000001"],
  ["1e300", "1e+300"],
  ["5e-324", "5e-324"],
  ["1/0", "inf"],
  ["-1/0", "-inf"],
  // Integers: exact up to |2^62| (LLONG_MAX/2 as a double), via double2ll.
  ["2^53", "9007199254740992"],
  ["2^53+2", "9007199254740994"],
  ["2^62", "4611686018427387904"],
  ["-2^62", "-4611686018427387904"],
  // Past 2^62 double2ll refuses and fpconv_dtoa prints the shortest form.
  ["2^62+1024", "4611686018427389000"],
  ["-2^62-1024", "-4611686018427389000"],
  ["2^63", "9223372036854776000"],
  ["1e21", "1e+21"]
];

for (const fn of ["call", "pcall"]) {
  test(`redis.${fn}: number arguments are formatted like Redis 7.4+`, async () => {
    const { engine, calls } = await capturingEngine();
    for (const [lua, expected] of NUMBER_ARGS) {
      calls.length = 0;
      engine.eval(`redis.${fn}('SET', 'k', ${lua})`);
      assert.deepEqual(calls, [["SET", "k", expected]], lua);
    }
  });
}

test("redis.call: NaN number argument is formatted by fpconv_dtoa", async () => {
  const { engine, calls } = await capturingEngine();
  // The NaN sign bit is platform-dependent (x86 Redis sends "-nan" for 0/0).
  engine.eval("redis.call('SET', 'k', 0/0, -(0/0))");
  assert.equal(calls.length, 1);
  assert.match(calls[0][2], /^-?nan$/);
  assert.match(calls[0][3], /^-?nan$/);
});

test("redis.call: string arguments are passed through, numbers in every position", async () => {
  const { engine, calls } = await capturingEngine();
  engine.eval("redis.call('HINCRBY', 'h', 'f', 1e15)");
  engine.eval("redis.call('SET', '1e15', '0.30', 7)");
  engine.eval("redis.call(1e15, 2.5)");
  assert.deepEqual(calls, [
    ["HINCRBY", "h", "f", "1000000000000000"],
    ["SET", "1e15", "0.30", "7"],
    ["1000000000000000", "2.5"]
  ]);
});

test("redis.call: formatting a number argument leaves the Lua value a number", async () => {
  const { engine, calls } = await capturingEngine();
  const r = engine.eval("local n = 0.1 + 0.2 redis.call('SET', 'k', n) return type(n)");
  assert.equal((r as Buffer).toString(), "number");
  assert.deepEqual(calls, [["SET", "k", "0.30000000000000004"]]);
});
