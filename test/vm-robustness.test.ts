/**
 * VM robustness and Redis-compatible randomness:
 * - running out of memory outside the script itself (KEYS/ARGV setup, reply
 *   encoding, the post-run collection) yields an error reply and leaves the
 *   engine usable, instead of reaching Lua's panic handler and exiting (#41);
 * - math.random / math.randomseed use Redis's PRNG and seeding rules (#45).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.js";
import type { CompatProfile, ReplyValue } from "../src/types.js";

type ErrReply = { err: Buffer; code?: Buffer };

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

async function standalone(options: Parameters<typeof load>[0] = {}) {
  return (await load(options)).createStandalone();
}

function assertUsable(engine: Awaited<ReturnType<typeof standalone>>): void {
  assert.equal(engine.eval("return 1 + 1"), 2);
  assert.deepEqual(engine.evalWithArgs("return {KEYS[1], ARGV[1], #KEYS, #ARGV}", ["k"], ["a"]), [
    Buffer.from("k"),
    Buffer.from("a"),
    1,
    1,
  ]);
  // Globals protection survived: KEYS/ARGV setup unlocks the globals table.
  assertErr(engine.eval("x = 1"), /Attempt to modify a readonly table/);
}

// =============================================================================
// Out of memory outside the script (#41)
// =============================================================================

/** `count` distinct 1 MB arguments (distinct, as Lua interns equal strings). */
function megabyteArgs(count: number): Buffer[] {
  return Array.from({ length: count }, (_, i) => {
    const arg = Buffer.alloc(1024 * 1024, 0x61);
    arg.writeUInt32LE(i, 0);
    return arg;
  });
}

test("vm robustness: ARGV that exhausts the heap while being set replies with an error", async () => {
  const engine = await standalone();
  // 40 MB fits the 64 MB heap as the encoded argument buffer, but copying it
  // into Lua strings does not.
  for (let round = 0; round < 2; round++) {
    const reply = assertErr(engine.evalWithArgs("return #ARGV", [], megabyteArgs(40)), "not enough memory to set KEYS/ARGV");
    assert.equal(String(reply.code), "ERR");
    assertUsable(engine);
  }
  // A large ARGV that fits still works afterwards.
  assert.equal(engine.evalWithArgs("return #ARGV", [], megabyteArgs(16)), 16);
});

test("vm robustness: KEYS that exhaust the heap while being set reply with an error", async () => {
  const engine = await standalone();
  assertErr(engine.evalWithArgs("return #KEYS", megabyteArgs(40), []), "not enough memory to set KEYS/ARGV");
  assertUsable(engine);
});

test("vm robustness: a script that fills the heap and returns keeps the engine usable", async () => {
  const engine = await standalone();
  const fill = "local t = {} pcall(function() for i = 1, 1e9 do t[i] = {} end end) return #t";
  for (let round = 0; round < 2; round++) {
    const count = engine.eval(fill);
    assert.equal(typeof count, "number");
    assert.ok((count as number) > 100000);
    assertUsable(engine);
  }
});

test("vm robustness: a heap the collector cannot free is recovered by rebuilding the VM", async () => {
  const engine = await standalone();
  // Many strings grow Lua's string table; filling the heap afterwards with
  // non-strings makes the collector's string-table shrink fail every time.
  engine.eval("local t = {} pcall(function() for i = 1, 1e9 do t[i] = tostring(i) end end) return #t");
  const reply = engine.eval("local t = {} pcall(function() for i = 1, 1e9 do t[i] = {} end end) return #t");
  if (typeof reply !== "number") {
    assertErr(reply, "not enough memory for the script reply");
  }
  assertUsable(engine);
  assert.equal(engine.eval("return #string.rep('y', 16 * 1024 * 1024)"), 16 * 1024 * 1024);
});

// =============================================================================
// math.random / math.randomseed (#45)
// =============================================================================

// Expected values were read from real servers (x86-64 Docker images): a fresh
// redis 7.0 / 7.4 / 8.0 and valkey 8.0 / 9.0 process returns 396465, then
// 840486, for math.random(1,1000000) and keeps one sequence across scripts;
// redis 6.2 reseeds with 0 before every script, so it returns 170829 each time.
const PERSISTENT_PROFILES: CompatProfile[] = ["redis-7.0", "redis-7.2", "redis-7.4", "redis-8.0", "valkey-8.0", "valkey-9.0"];

for (const profile of [undefined, ...PERSISTENT_PROFILES]) {
  test(`math.random: ${profile ?? "default"} profile continues one Redis sequence across scripts`, async () => {
    const engine = await standalone(profile ? { profile } : {});
    assert.equal(engine.eval("return math.random(1,1000000)"), 396465);
    assert.equal(engine.evalWithArgs("return math.random(1,1000000)", [], []), 840486);
    assert.deepEqual(engine.eval("return tostring(math.random())"), Buffer.from("0.35333609737146"));
  });
}

test("math.random: redis-6.2 profile reseeds with 0 before every script", async () => {
  const engine = await standalone({ profile: "redis-6.2" });
  assert.equal(engine.eval("return math.random(1,1000000)"), 170829);
  assert.equal(engine.eval("return math.random(1,1000000)"), 170829);
  assert.equal(engine.evalWithArgs("return math.random(1,1000000)", ["k"], ["a"]), 170829);
  assert.deepEqual(engine.eval("return tostring(math.random())"), Buffer.from("0.17082803611217"));
  assert.deepEqual(
    engine.eval("return {tostring(math.random()), tostring(math.random()), math.random(10)}"),
    [Buffer.from("0.17082803611217"), Buffer.from("0.74990198051087"), 1],
  );
});

test("math.random: reseedRandom override applies to any profile", async () => {
  const reseeding = await standalone({ profile: "redis-7.4", compat: { reseedRandom: true } });
  assert.equal(reseeding.eval("return math.random(1,1000000)"), 170829);
  assert.equal(reseeding.eval("return math.random(1,1000000)"), 170829);

  const persistent = await standalone({ profile: "redis-6.2", compat: { reseedRandom: false } });
  assert.equal(persistent.eval("return math.random(1,1000000)"), 396465);
  assert.equal(persistent.eval("return math.random(1,1000000)"), 840486);
});

test("math.randomseed: a seed carries over to later scripts, except on redis-6.2", async () => {
  const seeded = "math.randomseed(ARGV[1]); return {math.random(1,1000000), math.random(1,1000000)}";

  const engine = await standalone();
  assert.deepEqual(engine.evalWithArgs(seeded, [], ["10"]), [878852, 795807]);
  assert.deepEqual(engine.eval("return tostring(math.random())"), Buffer.from("0.48082728100979"));
  assert.deepEqual(engine.evalWithArgs(seeded, [], ["10"]), [878852, 795807]);
  assert.deepEqual(engine.eval("math.randomseed(0) return math.random(1,1000000)"), 170829);
  // luaL_checkint truncates: 2.9 seeds like 2.
  assert.deepEqual(
    engine.eval("math.randomseed(2.9) local a = math.random() math.randomseed(2) return a == math.random() and 1 or 0"),
    1,
  );

  const redis62 = await standalone({ profile: "redis-6.2" });
  assert.deepEqual(redis62.evalWithArgs(seeded, [], ["10"]), [878852, 795807]);
  assert.deepEqual(redis62.eval("return tostring(math.random())"), Buffer.from("0.17082803611217"));
});

test("math.random: argument handling matches Redis", async () => {
  const engine = await standalone();
  const errorOf = (call: string) => engine.eval(`local ok, e = pcall(${call}) return e`);
  assert.deepEqual(errorOf("math.random, 1, 2, 3"), Buffer.from("wrong number of arguments"));
  assert.deepEqual(errorOf("math.random, 3, 1"), Buffer.from("bad argument #2 to '?' (interval is empty)"));
  assert.deepEqual(errorOf("math.random, 0"), Buffer.from("bad argument #1 to '?' (interval is empty)"));
  assert.deepEqual(errorOf("math.randomseed"), Buffer.from("bad argument #1 to '?' (number expected, got no value)"));
  const inRange = engine.eval("local r = math.random(-3, 3) return (r >= -3 and r <= 3 and r == math.floor(r)) and 1 or 0");
  assert.equal(inRange, 1);
});

test("math.random: the replaced functions are protected like the rest of math", async () => {
  const engine = await standalone();
  assertErr(engine.eval("math.random = function() return 4 end"), /Attempt to modify a readonly table/);
  assertErr(engine.eval("math.randomseed = nil"), /Attempt to modify a readonly table/);
});
