/**
 * Engine lifecycle: the compiled WASM module is cached across load() calls
 * while every engine gets its own instance; LuaEngine.create/createStandalone;
 * reset(); dispose(); the deprecated LuaWasmEngine alias.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import v8 from "node:v8";
import vm from "node:vm";
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaEngine, LuaWasmEngine, WasmFault } from "../src/index.js";
import type { RedisHost, ReplyValue } from "../src/types.js";
import type { WasmExports } from "../src/loader-core.js";

const WASM_CANDIDATES = [
  path.resolve(process.cwd(), "dist/redis_lua.wasm"),
  path.resolve(process.cwd(), "wasm/build/redis_lua.wasm"),
];

async function wasmFile(): Promise<string> {
  for (const candidate of WASM_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`WASM file not found. Checked: ${WASM_CANDIDATES.join(", ")}`);
}

/** Runs `fn` while counting WebAssembly.compile calls. */
async function countingCompiles<T>(fn: (count: () => number) => Promise<T>): Promise<T> {
  const realCompile = WebAssembly.compile;
  let calls = 0;
  WebAssembly.compile = ((bytes: BufferSource) => {
    calls++;
    return realCompile(bytes);
  }) as typeof WebAssembly.compile;
  try {
    return await fn(() => calls);
  } finally {
    WebAssembly.compile = realCompile;
  }
}

function host(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall: () => ({ ok: Buffer.from("OK") }),
    redisPcall: () => ({ ok: Buffer.from("OK") }),
    log: () => {},
    ...overrides,
  };
}

function errText(value: ReplyValue): string {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  return (value as { err: Buffer }).err.toString("utf8");
}

function exportsOf(engine: LuaEngine): WasmExports {
  return (engine as unknown as { exports: WasmExports }).exports;
}

// cjson settings live in the Lua VM and persist across scripts, like in Redis:
// observable VM state that scripts can change despite the globals protection.
const LIMIT_DEPTH = "cjson.encode_max_depth(1) return 1";
const ENCODE_NESTED = "return cjson.encode({{1}})";

test("lifecycle: load() compiles wasmBytes once and reuses the compiled module", async () => {
  const bytes = new Uint8Array(await fs.readFile(await wasmFile()));
  await countingCompiles(async (compiles) => {
    const first = await load({ wasmBytes: bytes });
    assert.equal(compiles(), 1);
    const second = await load({ wasmBytes: bytes });
    assert.equal(compiles(), 1, "second load() must reuse the compiled module");

    const a = first.createStandalone();
    const b = second.createStandalone();
    assert.notEqual(exportsOf(a).HEAPU8.buffer, exportsOf(b).HEAPU8.buffer);
  });
});

test("lifecycle: load() reads and compiles a wasmPath once (path and file:// URL alike)", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lua-redis-wasm-"));
  const wasmPath = path.join(dir, "redis_lua.wasm");
  await fs.copyFile(await wasmFile(), wasmPath);
  try {
    await countingCompiles(async (compiles) => {
      const engine = (await load({ wasmPath })).createStandalone();
      assert.equal(compiles(), 1);
      // The file is not read again: removing it does not break later loads.
      await fs.rm(wasmPath);
      const again = (await load({ wasmPath })).createStandalone();
      const viaUrl = (await load({ wasmPath: pathToFileURL(wasmPath).href })).createStandalone();
      assert.equal(compiles(), 1);
      for (const e of [engine, again, viaUrl]) {
        assert.equal(e.eval("return 6 * 7"), 42);
      }
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("lifecycle: a failed compilation is not cached", async () => {
  const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
  await countingCompiles(async (compiles) => {
    await assert.rejects(load({ wasmBytes: garbage }), /Failed to instantiate redis_lua\.wasm/);
    await assert.rejects(load({ wasmBytes: garbage }), /Failed to instantiate redis_lua\.wasm/);
    assert.equal(compiles(), 2);
  });
});

test("lifecycle: engines from the cached module share no state", async () => {
  const bytes = new Uint8Array(await fs.readFile(await wasmFile()));
  const a = (await load({ wasmBytes: bytes })).createStandalone();
  const b = (await load({ wasmBytes: bytes })).createStandalone();

  // Lua VM state.
  assert.equal(a.eval(LIMIT_DEPTH), 1);
  assert.match(errText(a.eval(ENCODE_NESTED)), /Cannot serialise, excessive nesting/);
  assert.deepEqual(b.eval(ENCODE_NESTED), Buffer.from("[[1]]"));

  // C state outside the VM: each instance has its own math.random generator.
  const fromA = a.eval("return {math.random(1000000), math.random(1000000)}");
  const fromB = b.eval("return {math.random(1000000), math.random(1000000)}");
  assert.deepEqual(fromB, fromA);

  // Host callbacks.
  const seen: string[] = [];
  const withHostA = (await load({ wasmBytes: bytes })).create(
    host({ redisCall: () => (seen.push("a"), { ok: Buffer.from("A") }) }),
  );
  const withHostB = (await load({ wasmBytes: bytes })).create(
    host({ redisCall: () => (seen.push("b"), { ok: Buffer.from("B") }) }),
  );
  assert.deepEqual(withHostB.eval("return redis.call('PING')"), { ok: Buffer.from("B") });
  assert.deepEqual(withHostA.eval("return redis.call('PING')"), { ok: Buffer.from("A") });
  assert.deepEqual(seen, ["b", "a"]);
});

test("lifecycle: LuaEngine.create / createStandalone", async () => {
  const engine = await LuaEngine.create({
    host: host({ redisCall: (args) => ({ ok: args[0] }) }),
    limits: { maxFuel: 1_000_000 },
  });
  assert.ok(engine instanceof LuaEngine);
  assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("PING") });
  assert.deepEqual(engine.getLimits(), { maxFuel: 1_000_000 });

  const standalone = await LuaEngine.createStandalone();
  assert.ok(standalone instanceof LuaEngine);
  assert.equal(standalone.eval("return math.sqrt(16)"), 4);
  assert.match(errText(standalone.eval("return redis.call('PING')")), /not available in standalone mode/);

  assert.equal(typeof LuaEngine.defaultWasmPath(), "string");
  assert.equal(typeof LuaEngine.defaultModulePath(), "string");
});

test("lifecycle: LuaWasmEngine is a deprecated alias of LuaEngine", async () => {
  assert.equal(LuaWasmEngine, LuaEngine);
  const engine: LuaWasmEngine = await LuaWasmEngine.create({ host: host() });
  assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("OK") });
  assert.deepEqual(engine.evalWithArgs("return {KEYS[1], ARGV[1]}", ["k"], ["v"]), [
    Buffer.from("k"),
    Buffer.from("v"),
  ]);
  assert.equal(engine.getLimits(), undefined);
  const standalone = await LuaWasmEngine.createStandalone();
  assert.equal(standalone.eval("return 1"), 1);
  assert.equal(LuaWasmEngine.defaultWasmPath(), LuaEngine.defaultWasmPath());

  // Both the value and the type carry a @deprecated doc comment.
  const source = await fs.readFile(path.resolve(process.cwd(), "src/engine.ts"), "utf8");
  for (const declaration of [
    "export const LuaWasmEngine = LuaEngine;",
    "export type LuaWasmEngine = LuaEngine;",
  ]) {
    const at = source.indexOf(declaration);
    assert.ok(at > 0, declaration);
    const doc = source.slice(source.lastIndexOf("/**", at), at);
    assert.match(doc, /^\/\*\*[\s\S]*@deprecated[\s\S]*\*\/\s*$/, declaration);
  }
});

test("lifecycle: dispose() makes eval/evalWithArgs/reset throw and is idempotent", async () => {
  const engine = await LuaEngine.createStandalone({ limits: { maxFuel: 5_000 } });
  assert.equal(engine.eval("return 1"), 1);
  engine.dispose();
  engine.dispose();
  assert.throws(() => engine.eval("return 1"), /LuaEngine has been disposed/);
  assert.throws(() => engine.evalWithArgs("return 1", ["k"], ["v"]), /LuaEngine has been disposed/);
  assert.throws(() => engine.reset(), /LuaEngine has been disposed/);
  assert.deepEqual(engine.getLimits(), { maxFuel: 5_000 });
});

test("lifecycle: dispose() closes the Lua VM and drops the instance and the host", async () => {
  const engine = await LuaEngine.create({ host: host() });
  const exports = exportsOf(engine);
  let closes = 0;
  const realClose = exports._close_vm!;
  exports._close_vm = () => (closes++, realClose());
  engine.dispose();
  engine.dispose();
  assert.equal(closes, 1);
  const internals = engine as unknown as { instance: unknown; handlers: unknown };
  assert.equal(internals.instance, null);
  assert.equal(internals.handlers, null);
  // The VM is gone from the instance too.
  const retPtr = exports._alloc(8);
  const script = Buffer.from("return 1");
  const scriptPtr = exports._alloc(script.length);
  exports.HEAPU8.set(script, scriptPtr);
  exports._eval(retPtr, scriptPtr, script.length);
  const view = new DataView(exports.HEAPU8.buffer);
  const ptr = view.getUint32(retPtr, true);
  const len = view.getUint32(retPtr + 4, true);
  assert.match(Buffer.from(exports.HEAPU8.subarray(ptr + 5, ptr + len)).toString(), /Lua VM not initialized/);
});

test("lifecycle: a disposed engine no longer keeps its WASM memory alive", async () => {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc") as () => void;
  let collected = 0;
  const registry = new FinalizationRegistry(() => {
    collected++;
  });
  // Both the engine and its module stay referenced; only dispose() lets go.
  const kept: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const module = await load();
    const engine = module.create(host());
    assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("OK") });
    registry.register(exportsOf(engine).HEAPU8.buffer, i);
    engine.dispose();
    kept.push(module, engine);
  }
  for (let i = 0; i < 50 && collected < 3; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(collected, 3);
  assert.equal(kept.length, 6);
});

test("lifecycle: dispose() from a host callback is refused and leaves the engine intact", async () => {
  let engine!: LuaEngine;
  let refusal: unknown;
  engine = await LuaEngine.create({
    host: host({
      redisCall: () => {
        try {
          engine.dispose();
        } catch (err) {
          refusal = err;
        }
        return { ok: Buffer.from("OK") };
      },
      redisPcall: () => {
        engine.dispose(); // escapes into the script as an error reply
        return null;
      },
    }),
  });
  assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("OK") });
  assert.ok(refusal instanceof Error);
  assert.match(refusal.message, /LuaEngine\.dispose\(\) cannot be called while a script is running/);
  assert.match(
    errText(engine.eval("return redis.pcall('PING')")),
    /LuaEngine\.dispose\(\) cannot be called while a script is running/,
  );
  assert.equal(engine.eval("return 2"), 2);
  engine.dispose();
  assert.throws(() => engine.eval("return 1"), /LuaEngine has been disposed/);
});

test("lifecycle: dispose() of a faulted engine only drops it", async () => {
  const engine = await LuaEngine.createStandalone();
  const exports = exportsOf(engine);
  exports._alloc = () => {
    throw new Error("abort");
  };
  assert.throws(() => engine.eval("return 1"));
  assert.throws(() => engine.eval("return 1"), /LuaEngine is unusable/);
  let closes = 0;
  exports._close_vm = () => (closes++, 0);
  engine.dispose();
  assert.equal(closes, 0);
  assert.throws(() => engine.eval("return 1"), /LuaEngine has been disposed/);
});

test("lifecycle: reset() gives a fresh Lua VM", async () => {
  const engine = await LuaEngine.createStandalone();
  assert.equal(engine.eval(LIMIT_DEPTH), 1);
  assert.match(errText(engine.eval(ENCODE_NESTED)), /excessive nesting/);
  engine.reset();
  assert.deepEqual(engine.eval(ENCODE_NESTED), Buffer.from("[[1]]"));
  engine.reset();
  engine.reset();
  assert.equal(engine.eval("return 1"), 1);
});

test("lifecycle: reset() keeps limits, compat profile, redisProps and host", async () => {
  const engine = await LuaEngine.create({
    host: host({ redisCall: () => ({ ok: Buffer.from("HOST") }) }),
    limits: { maxFuel: 100_000 },
    profile: "redis-6.2",
    redisProps: { REDIS_VERSION: { value: "6.2.14" } },
  });
  const check = (): void => {
    assert.match(errText(engine.eval("while true do end")), /Script killed by fuel limit/);
    assert.deepEqual(engine.eval("return type(print)"), Buffer.from("function"));
    assert.equal(engine.eval("return rawget(_G, 'server') == nil"), 1);
    assert.deepEqual(engine.eval("return redis.REDIS_VERSION"), Buffer.from("6.2.14"));
    assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("HOST") });
  };
  check();
  engine.reset();
  check();
});

test("lifecycle: reset() from a host callback is refused", async () => {
  let engine!: LuaEngine;
  let refusal: unknown;
  engine = await LuaEngine.create({
    host: host({
      redisCall: () => {
        try {
          engine.reset();
        } catch (err) {
          refusal = err;
        }
        return { ok: Buffer.from("OK") };
      },
    }),
  });
  assert.equal(engine.eval(LIMIT_DEPTH), 1);
  assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("OK") });
  assert.ok(refusal instanceof Error);
  assert.match(refusal.message, /LuaEngine\.reset\(\) cannot be called while a script is running/);
  // Nothing was reset.
  assert.match(errText(engine.eval(ENCODE_NESTED)), /excessive nesting/);
});

test("lifecycle: reset() recovers from a failed rebuild", async () => {
  const engine = await LuaEngine.createStandalone();
  const exports = exportsOf(engine);
  // A failed rebuild leaves no VM (e.g. out of memory while building it).
  exports._close_vm!();
  assert.match(errText(engine.eval("return 1")), /Lua VM not initialized/);
  engine.reset();
  assert.equal(engine.eval("return 1"), 1);

  const realReset = exports._reset;
  exports._reset = () => -1;
  assert.throws(() => engine.reset(), /Failed to reset the Lua VM/);
  exports._reset = realReset;
  engine.reset();
  assert.equal(engine.eval("return 1"), 1);
});

test("lifecycle: reset() leaves no VM when the redisProps cannot be fetched", async () => {
  const engine = await LuaEngine.createStandalone({
    redisProps: { REDIS_VERSION: { value: "7.4.0" } },
  });
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;
  // The props import allocates the blob during _reset: the heap is "full".
  exports._alloc = () => 0;
  assert.throws(() => engine.reset(), RangeError);
  exports._alloc = realAlloc;
  // Not a VM built without the props: none at all, until reset() succeeds.
  assert.match(errText(engine.eval("return redis.REDIS_VERSION")), /Lua VM not initialized/);
  engine.reset();
  assert.deepEqual(engine.eval("return redis.REDIS_VERSION"), Buffer.from("7.4.0"));
});

test("lifecycle: a WasmFault while reset() fetches the redisProps makes the engine unusable", async () => {
  const engine = await LuaEngine.createStandalone({
    redisProps: { REDIS_VERSION: { value: "7.4.0" } },
  });
  const exports = exportsOf(engine);
  const realAlloc = exports._alloc;
  const abort = new Error("abort");
  exports._alloc = () => {
    throw abort;
  };
  assert.throws(
    () => engine.reset(),
    (err: unknown) => err instanceof WasmFault && err.cause === abort,
  );
  exports._alloc = realAlloc;
  assert.throws(() => engine.eval("return 1"), /LuaEngine is unusable/);
  assert.throws(() => engine.reset(), /LuaEngine is unusable/);
  engine.dispose();
  assert.throws(() => engine.eval("return 1"), /LuaEngine has been disposed/);
});

test("lifecycle: wasmBytes may be an ArrayBuffer, cached by identity", async () => {
  const file = await fs.readFile(await wasmFile());
  const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  // A view into a larger buffer compiles only its own bytes.
  const padded = new Uint8Array(file.length + 16);
  padded.set(file, 8);
  const view = padded.subarray(8, 8 + file.length);
  await countingCompiles(async (compiles) => {
    const a = (await load({ wasmBytes: arrayBuffer })).createStandalone();
    const b = await LuaEngine.createStandalone({ wasmBytes: arrayBuffer });
    assert.equal(compiles(), 1);
    const c = await LuaEngine.createStandalone({ wasmBytes: view });
    assert.equal(compiles(), 2);
    assert.equal(a.eval("return 1"), 1);
    assert.equal(b.eval("return 2"), 2);
    assert.equal(c.eval("return 3"), 3);
  });
});

test("lifecycle: a module hands its instance over and cannot be reused", async () => {
  const module = await load();
  const engine = module.createStandalone();
  assert.equal((module as unknown as { exports: unknown }).exports, null);
  assert.throws(() => module.createStandalone(), /already been used/);
  assert.throws(() => module.create(host()), /already been used/);
  assert.equal(engine.eval("return 1"), 1);
});
