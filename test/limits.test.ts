/**
 * EngineLimits: maxReplyBytes (enforced while the reply is encoded),
 * maxArgBytes, maxMemoryBytes (Lua heap cap) and limit validation. All limits
 * are enforced by the WASM runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, LuaEngine } from "../src/index.js";
import type { EngineLimits, RedisHost, ReplyValue } from "../src/types.js";
import type { WasmExports } from "../src/loader-core.js";

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
// maxMemoryBytes (#54)
// =============================================================================

const HOG = "local t = {} for i = 1, 64 do t[i] = string.rep('x', 64 * 1024) .. i end return #t";

test("maxMemoryBytes: a script growing past the cap gets 'not enough memory'; the engine stays usable", async () => {
  const engine = await engineWith({ maxMemoryBytes: 1024 * 1024 });
  for (let round = 0; round < 3; round++) {
    const reply = assertErr(engine.eval(HOG), "not enough memory");
    assert.equal(reply.meta?.sha, sha1(HOG));
    assertUsable(engine);
    // Small and moderately allocating scripts are fine.
    assert.equal(engine.eval("local t = {} for i = 1, 5000 do t[i] = 'v' .. i end return #t"), 5000);
    // Garbage is collected as the script runs: 20 MB allocated in total.
    assert.equal(
      engine.eval("local n = 0 for i = 1, 20000 do n = n + #(string.rep('y', 1000) .. i) end return n"),
      20000 * 1000 + 88894,
    );
  }
  // The same script is fine without a cap.
  assert.equal((await load()).createStandalone().eval(HOG), 64);
});

test("maxMemoryBytes: pcall catches the memory error inside the script", async () => {
  const engine = await engineWith({ maxMemoryBytes: 1024 * 1024 });
  const script = `local ok, e = pcall(function() ${HOG} end) return {ok and 1 or 0, e}`;
  assert.deepEqual(engine.eval(script), [0, Buffer.from("not enough memory")]);
  assertUsable(engine);
});

test("maxMemoryBytes: a redis.call reply larger than the cap is a memory error", async () => {
  const big = Buffer.alloc(2 * 1024 * 1024, "r");
  const engine = await engineWith({ maxMemoryBytes: 1024 * 1024 }, { redisCall: () => big });
  assertErr(engine.eval("return #redis.call('GET', 'k')"), "not enough memory");
  assertUsable(engine);
});

// A C module holding a buffer outside Lua while a Lua allocation fails must not
// lose it: the failures below repeat many times under the cap, and the WASM
// heap must be as large afterwards as before (a leak of a few hundred KB per
// failure would add up to tens of MB and eventually abort the module).

/** Free WASM heap in blocks of at least 64 KB (so fragmentation-tolerant). */
function freeHeap(engine: LuaEngine): number {
  const exports = (engine as unknown as { exports: WasmExports }).exports;
  const largest = (): number => {
    let lo = 0;
    let hi = 64 * 1024 * 1024;
    while (hi - lo > 64 * 1024) {
      const mid = Math.floor((lo + hi) / 2);
      const ptr = exports._alloc(mid);
      if (ptr) {
        exports._free_mem(ptr);
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  };
  const held: number[] = [];
  let total = 0;
  for (let size = largest(); size >= 64 * 1024; size = largest()) {
    const ptr = exports._alloc(size);
    if (!ptr) {
      break;
    }
    held.push(ptr);
    total += size;
  }
  held.forEach((ptr) => exports._free_mem(ptr));
  return total;
}

/** Runs `round` `rounds` times and checks the WASM heap did not shrink. */
function assertNoHeapLoss(engine: LuaEngine, rounds: number, round: () => void): void {
  round(); // settle one-time allocations (interned strings, grown Lua stack)
  const before = freeHeap(engine);
  for (let i = 0; i < rounds; i++) {
    round();
  }
  const after = freeHeap(engine);
  assert.ok(after >= before - 512 * 1024, `free heap shrank from ${before} to ${after} bytes`);
  assertUsable(engine);
}

// How many small tables still fit under the cap after a full collection: drops
// when memory counted toward maxMemoryBytes was not given back.
const CAPACITY =
  "collectgarbage() local n, l = 0 pcall(function() while true do l = {l} n = n + 1 end end) l = nil return n";

// Fills the Lua heap up to the cap (collector stopped), leaving less room than
// a small string needs.
const FILL = "collectgarbage('stop') local fill pcall(function() while true do fill = {fill} end end)";

test("maxMemoryBytes: cmsgpack past the cap raises instead of aborting, and its buffers are freed", async () => {
  const engine = await engineWith({ maxMemoryBytes: 2 * 1024 * 1024 });
  const capacity = engine.eval(CAPACITY) as number;
  const build = "local t = {} for i = 1, 2500 do t[i] = string.rep('z', 400) .. i end";
  assertErr(engine.eval(`${build} return #cmsgpack.pack(t)`), "not enough memory");
  // Each failed pack abandons its buffer, counted toward the cap until the
  // script ends; then they are freed and the whole cap is available again.
  const failing = `${build} local n = 0 for j = 1, 50 do if not pcall(cmsgpack.pack, t) then n = n + 1 end end return n`;
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.eval(failing), 50));
  assert.ok((engine.eval(CAPACITY) as number) >= capacity * 0.95);
  // Packing within the cap still works.
  assert.deepEqual(engine.eval("return cmsgpack.unpack(cmsgpack.pack({1, 'two', {3}}))[2]"), Buffer.from("two"));
});

test("maxMemoryBytes: a failing cjson.decode does not leak its scratch buffer", async () => {
  const engine = await engineWith({ maxMemoryBytes: 2 * 1024 * 1024 });
  const json = "[" + Array(200_000).fill("1").join(",") + "]"; // ~400 KB, decodes to more than the cap
  const script = "local n = 0 for i = 1, 20 do if not pcall(cjson.decode, ARGV[1]) then n = n + 1 end end return n";
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.evalWithArgs(script, [], [json]), 20));
  assert.equal(engine.eval("return cjson.decode('[1,2,3]')[3]"), 3);
});

test("maxMemoryBytes: a failing cjson.encode does not leak its buffer", async () => {
  const engine = await engineWith({ maxMemoryBytes: 2 * 1024 * 1024 });
  const build = "local t = {} for i = 1, 20000 do t[i] = 'abcdefghijklmnopqrstuvwxyz0123456789' end";
  const fails = (keep: boolean) =>
    `cjson.encode_keep_buffer(${keep}) ${build} local n = 0 for i = 1, 5 do if not pcall(cjson.encode, t) then n = n + 1 end end return n`;
  // A private buffer (encode_keep_buffer off) is abandoned by every failure.
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.eval(fails(false)), 5));
  // The kept buffer survives failures and still works.
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.eval(fails(true)), 5));
  assert.deepEqual(engine.eval("return cjson.encode({1, 'a'})"), Buffer.from('[1,"a"]'));
});

test("maxMemoryBytes: cjson's kept encode buffer does not hold on to the cap after a large encode", async () => {
  const engine = await engineWith({ maxMemoryBytes: 4 * 1024 * 1024 });
  const capacity = engine.eval(CAPACITY) as number;
  // ~1.2 MB of JSON grows the kept encode buffer to 2 MB, half the cap.
  assert.equal(
    engine.eval("local t = {} for i = 1, 30000 do t[i] = string.rep('j', 38) end return #cjson.encode(t)"),
    30000 * 41 + 1,
  );
  // It is shrunk back once the script ends.
  assert.ok((engine.eval(CAPACITY) as number) >= capacity * 0.95);
  assert.deepEqual(engine.eval("return cjson.encode({x = 1})"), Buffer.from('{"x":1}'));
});

test("cjson.encode of a value expanding past the heap raises instead of aborting", async () => {
  // 2^22 copies of the same table: the old strbuf.c called abort() at 16 MB.
  const script = "local t = {} for i = 1, 22 do t = {t, t} end return #cjson.encode(t)";
  const unlimited = (await load()).createStandalone();
  assertErr(unlimited.eval(script), "not enough memory");
  assertUsable(unlimited);
  const capped = await engineWith({ maxMemoryBytes: 4 * 1024 * 1024 });
  assertErr(capped.eval(script), "not enough memory");
  assertUsable(capped);
});

test("maxMemoryBytes: redis.call at the cap does not leak its argument buffer", async () => {
  let calls = 0;
  const engine = await engineWith(
    { maxMemoryBytes: 4 * 1024 * 1024 },
    { redisCall: () => (calls++, 1), redisPcall: () => 1 },
  );
  // A 1 MB argument followed by a number, with the Lua heap full: the number is
  // formatted without allocating, so the command still reaches the host.
  const script = `local big = string.rep('x', 1000000) ${FILL}
    local n = 0 for i = 1, 5 do if pcall(redis.call, 'SET', big, 1234567.5 + i) then n = n + 1 end end
    fill = nil collectgarbage('restart') return n`;
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.eval(script), 5));
  assert.equal(calls, 55);
});

test("maxMemoryBytes: redis.sha1hex at the cap does not leak the host's digest", async () => {
  const engine = await engineWith({ maxMemoryBytes: 1024 * 1024 });
  // No room for the 40-byte result: every call fails after the host answered.
  const script = `${FILL}
    local n = 0 for i = 1, 5000 do if not pcall(redis.sha1hex, 'x') then n = n + 1 end end
    fill = nil collectgarbage('restart') return n`;
  assertNoHeapLoss(engine, 10, () => assert.equal(engine.eval(script), 5000));
  assert.deepEqual(engine.eval("return redis.sha1hex('')"), Buffer.from("da39a3ee5e6b4b0d3255bfef95601890afd80709"));
});

// =============================================================================
// Limit validation
// =============================================================================

test("limits: values that are not non-negative integers are rejected by load()", async () => {
  for (const limits of [
    { maxFuel: -1 },
    { maxMemoryBytes: Number.NaN },
    { maxReplyBytes: -5 },
    { maxArgBytes: "10" as unknown as number },
    // A fraction below 1 must not round down to 0 (no limit).
    { maxReplyBytes: 0.5 },
    { maxMemoryBytes: 0.9 },
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
