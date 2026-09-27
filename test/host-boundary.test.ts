/**
 * Host-boundary safety: exceptions from host callbacks, malformed host replies
 * and WASM heap exhaustion must surface as ordinary Lua errors (or a clear JS
 * exception) and never leave the engine in a corrupted state.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaEngine, LuaWasmModule } from "../src/index.js";
import type { RedisHost, ReplyValue } from "../src/types.js";
import type { WasmExports } from "../src/loader-core.js";
import { WasmFault } from "../src/helpers.js";

type ErrReply = { err: Buffer; code?: Buffer; meta?: { line: number } };

function host(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall: () => ({ ok: Buffer.from("OK") }),
    redisPcall: () => ({ ok: Buffer.from("OK") }),
    log: () => {},
    ...overrides,
  };
}

function exportsOf(target: LuaEngine | LuaWasmModule): WasmExports {
  return (target as unknown as { exports: WasmExports }).exports;
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

// =============================================================================
// Throwing host callbacks
// =============================================================================

test("host boundary: a throwing log handler raises a Lua error; the engine stays usable", async () => {
  const engine = (await load()).create(
    host({
      log() {
        throw new Error("log sink down");
      },
    }),
  );

  const reply = assertErr(
    engine.eval("redis.log(redis.LOG_NOTICE, 'x')\nreturn 'unreached'"),
    "log sink down",
  );
  assert.equal(reply.meta?.line, 1);

  // It is an ordinary Lua error: pcall catches it and the script continues.
  assert.deepEqual(
    engine.eval("local ok, e = pcall(redis.log, redis.LOG_NOTICE, 'x') return {tostring(ok), e}"),
    [Buffer.from("false"), Buffer.from("log sink down")],
  );
  assertUsable(engine);
});

test("host boundary: a non-Error throw or an empty message from log still raises", async () => {
  let thrown: unknown = "plain string";
  const engine = (await load()).create(
    host({
      log() {
        throw thrown;
      },
    }),
  );
  assertErr(engine.eval("redis.log(redis.LOG_NOTICE, 'x')"), "plain string");

  thrown = new Error("");
  assertErr(engine.eval("redis.log(redis.LOG_NOTICE, 'x')"), "host callback failed");
  assertUsable(engine);
});

test("host boundary: a throwing onSetResp raises a Lua error and keeps the protocol", async () => {
  const engine = (await load()).create(
    host({
      redisCall: () => null,
      onSetResp() {
        throw new Error("setresp rejected");
      },
    }),
  );

  assertErr(engine.eval("redis.setresp(3)"), "setresp rejected");
  // The switch was refused: a RESP null still decodes as false (RESP2), not nil.
  assert.deepEqual(
    engine.eval("local ok, e = pcall(redis.setresp, 3) return {tostring(ok), e, redis.call('GET', 'k') == false}"),
    [Buffer.from("false"), Buffer.from("setresp rejected"), 1],
  );
  assertUsable(engine);
});

// =============================================================================
// Malformed host replies
// =============================================================================

const malformedReplies: Array<[string, () => ReplyValue, RegExp]> = [
  ["{ map: 'x' }", () => ({ map: "x" }) as unknown as ReplyValue, /flatMap is not a function/],
  ["non-Buffer ok", () => ({ ok: 123 }) as unknown as ReplyValue, /status reply must be a Buffer/],
  ["nested non-Buffer err", () => [1, { err: {} }] as unknown as ReplyValue, /error reply must be a Buffer/],
  [
    "a reply nested deeper than the JS stack",
    () => {
      let value: ReplyValue = null;
      for (let i = 0; i < 200_000; i++) {
        value = [value];
      }
      return value;
    },
    /Maximum call stack size exceeded/,
  ],
];

for (const [label, reply, message] of malformedReplies) {
  test(`host boundary: malformed redis.call reply (${label}) raises a Lua error`, async () => {
    const engine = (await load()).create(host({ redisCall: reply }));
    const result = assertErr(engine.eval("return redis.call('GET', 'k')"), message);
    assert.equal(result.meta?.line, 1); // a script-aborting error
    assertUsable(engine);
  });

  test(`host boundary: malformed redis.pcall reply (${label}) is returned as an error table`, async () => {
    const engine = (await load()).create(host({ redisPcall: reply }));
    assert.deepEqual(
      engine.eval("local r = redis.pcall('GET', 'k') return {type(r), type(r.err)}"),
      [Buffer.from("table"), Buffer.from("string")],
    );
    const result = assertErr(engine.eval("return redis.pcall('GET', 'k')"), message);
    assert.equal(result.meta, undefined); // returned by the script, not aborted
    assertUsable(engine);
  });
}

// =============================================================================
// Heap exhaustion
// =============================================================================

test("host boundary: KEYS/ARGV larger than the WASM heap throw RangeError", async () => {
  const engine = (await load()).createStandalone();
  const huge = Buffer.alloc(70 * 1024 * 1024, 0x61); // the heap is 64 MB

  assert.throws(() => engine.evalWithArgs("return #ARGV[1]", [], [huge]), RangeError);
  assertUsable(engine);
  // Still room for a large (but fitting) argument afterwards.
  assert.equal(engine.evalWithArgs("return #ARGV[1]", [], [huge.subarray(0, 8 * 1024 * 1024)]), 8 * 1024 * 1024);
});

test("host boundary: a Lua script exhausting the heap gets a normal error", async () => {
  const engine = (await load()).createStandalone();
  const hog = "local t = {} for i = 1, 200 do t[i] = string.rep('x', 1024 * 1024) .. i end return #t";

  for (let round = 0; round < 2; round++) {
    assertErr(engine.eval(hog), /not enough memory/);
    assertUsable(engine);
    // The garbage from the failed script is reclaimed.
    assert.equal(engine.eval("return #string.rep('y', 16 * 1024 * 1024)"), 16 * 1024 * 1024);
  }
});

test("host boundary: eval/evalWithArgs throw RangeError when _alloc returns 0", async () => {
  const engine = (await load()).createStandalone();
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;

  exports._alloc = () => 0;
  assert.throws(() => engine.eval("return 1"), RangeError);
  assert.throws(() => engine.evalWithArgs("return 1", ["k"], ["a"]), RangeError);

  exports._alloc = realAlloc;
  assertUsable(engine);
});

test("host boundary: a throwing _alloc marks the engine unusable", async () => {
  const engine = (await load()).createStandalone();
  const exports = exportsOf(engine);
  const abort = new Error("Aborted(OOM)");

  exports._alloc = () => {
    throw abort;
  };
  assert.throws(
    () => engine.eval("return 1"),
    (err: unknown) => err instanceof WasmFault && err.cause === abort,
  );
  assert.throws(
    () => engine.eval("return 1"),
    (err: unknown) => err instanceof Error && /LuaEngine is unusable/.test(err.message),
  );
});

test("host boundary: a throwing _alloc inside a host import marks the engine unusable", async () => {
  const abort = new Error("Aborted(OOM)");
  let exports: WasmExports | undefined;
  let realAlloc: WasmExports["_alloc"] | undefined;
  const engine = (await load()).create(
    host({
      redisCall: () => {
        exports!._alloc = () => {
          throw abort;
        };
        return Buffer.from("value");
      },
    }),
  );
  exports = exportsOf(engine);
  realAlloc = exports._alloc;

  assert.throws(
    () => engine.eval("return redis.call('GET', 'k')"),
    (err: unknown) => err instanceof WasmFault && err.cause === abort,
  );
  exports._alloc = realAlloc;
  assert.throws(() => engine.eval("return 1"), /LuaEngine is unusable/);
});

test("host boundary: a failed return-slot allocation frees the script buffers", async () => {
  const engine = (await load()).createStandalone();
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;
  const realFree = exports._free_mem;
  const allocated: number[] = [];
  const freed = new Set<number>();
  let failAt = Infinity;

  exports._alloc = (size: number) => {
    if (allocated.length === failAt) {
      return 0;
    }
    const ptr = realAlloc(size);
    allocated.push(ptr);
    return ptr;
  };
  exports._free_mem = (ptr: number) => {
    freed.add(ptr);
    realFree(ptr);
  };

  failAt = 1; // script ok, return slot fails
  assert.throws(() => engine.eval("return 1"), RangeError);
  assert.deepEqual(allocated.map((p) => freed.has(p)), [true]);

  allocated.length = 0;
  failAt = 2; // script + KEYS/ARGV ok, return slot fails
  assert.throws(() => engine.evalWithArgs("return 1", ["k"], ["a"]), RangeError);
  assert.deepEqual(allocated.map((p) => freed.has(p)), [true, true]);

  allocated.length = 0;
  failAt = 1; // script ok, KEYS/ARGV fails
  assert.throws(() => engine.evalWithArgs("return 1", ["k"], ["a"]), RangeError);
  assert.deepEqual(allocated.map((p) => freed.has(p)), [true]);

  exports._alloc = realAlloc;
  exports._free_mem = realFree;
  assertUsable(engine);
});

test("host boundary: script buffers are freed when the script raises a host error", async () => {
  const engine = (await load()).create(
    host({
      log() {
        throw new Error("boom");
      },
    }),
  );
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;
  const realFree = exports._free_mem;
  const allocated: number[] = [];
  const freed = new Set<number>();
  exports._alloc = (size: number) => {
    const ptr = realAlloc(size);
    allocated.push(ptr);
    return ptr;
  };
  exports._free_mem = (ptr: number) => {
    freed.add(ptr);
    realFree(ptr);
  };

  assertErr(engine.evalWithArgs("redis.log(redis.LOG_NOTICE, KEYS[1])", ["k"], []), "boom");
  // script, KEYS/ARGV and the return slot are freed by JS; the error message
  // handed to C (allocated last) is freed by C.
  assert.equal(allocated.length, 4);
  assert.deepEqual(allocated.slice(0, 3).map((p) => freed.has(p)), [true, true, true]);

  exports._alloc = realAlloc;
  exports._free_mem = realFree;
});

test("host boundary: heap exhaustion while encoding a host reply raises a Lua error", async () => {
  let failAlloc = false;
  const engine = (await load()).create(
    host({
      redisCall: () => {
        failAlloc = true;
        return Buffer.from("value");
      },
      log() {
        failAlloc = true;
        throw new Error("boom");
      },
    }),
  );
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;
  exports._alloc = (size: number) => (failAlloc ? 0 : realAlloc(size));

  // Neither the reply nor the fallback error reply can be allocated.
  assertErr(engine.eval("return redis.call('GET', 'k')"), /empty reply from host/);
  failAlloc = false;
  // The log error message cannot be allocated: C raises a generic error.
  assertErr(engine.eval("redis.log(redis.LOG_NOTICE, 'x')"), "host callback failed");
  failAlloc = false;
  // The 40-byte sha1hex digest cannot be allocated.
  exports._alloc = (size: number) => (size === 40 ? 0 : realAlloc(size));
  assertErr(engine.eval("return redis.sha1hex('x')"), /sha1hex failed/);

  exports._alloc = realAlloc;
  assertUsable(engine);
});

test("host boundary: a redisProps allocation failure fails create()", async () => {
  const module = await load({ redisProps: { V: { value: "7.4.0" } } });
  exportsOf(module)._alloc = () => 0;
  assert.throws(() => module.create(host()), RangeError);
});

// =============================================================================
// Unexpected exceptions escaping WASM
// =============================================================================

test("host boundary: an exception escaping WASM marks the engine unusable", async () => {
  const engine = (await load()).createStandalone();
  const exports = exportsOf(engine);
  const boom = new Error("trap");
  exports._eval = () => {
    throw boom;
  };

  assert.throws(() => engine.eval("return 1"), (err: unknown) => err === boom);
  for (const run of [() => engine.eval("return 1"), () => engine.evalWithArgs("return 1")]) {
    assert.throws(run, (err: unknown) =>
      err instanceof Error && /LuaEngine is unusable/.test(err.message) && err.cause === boom,
    );
  }
});
