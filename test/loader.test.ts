import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.ts";

async function readWasm(): Promise<Uint8Array> {
  const candidates = [
    path.resolve(process.cwd(), "dist/redis_lua.wasm"),
    path.resolve(process.cwd(), "wasm/build/redis_lua.wasm")
  ];
  for (const candidate of candidates) {
    try {
      return new Uint8Array(await fs.readFile(candidate));
    } catch {
      continue;
    }
  }
  throw new Error(`WASM file not found. Checked: ${candidates.join(", ")}`);
}

/**
 * Fail (instead of hanging the suite) if `promise` does not settle in time —
 * a regression of the "load() never settles" bug must surface as a failure.
 */
async function settleWithin<T>(promise: Promise<T>, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`load() did not settle within ${ms}ms`)),
      ms
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Encode an unsigned LEB128 integer. */
function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function name(str: string): number[] {
  const bytes = [...Buffer.from(str, "utf8")];
  return [...uleb(bytes.length), ...bytes];
}

function section(id: number, content: number[]): number[] {
  return [id, ...uleb(content.length), ...content];
}

/** A valid wasm module whose only import is `module.field: () -> ()`. */
function moduleImporting(module: string, field: string): Uint8Array {
  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  const types = section(1, [0x01, 0x60, 0x00, 0x00]);
  const imports = section(2, [0x01, ...name(module), ...name(field), 0x00, 0x00]);
  return new Uint8Array([...header, ...types, ...imports]);
}

test("load() rejects on truncated wasm bytes instead of hanging", async () => {
  const wasm = await readWasm();
  const truncated = wasm.slice(0, Math.floor(wasm.length / 2));
  await assert.rejects(settleWithin(load({ wasmBytes: truncated })), (err: Error) => {
    assert.match(err.message, /Failed to instantiate redis_lua\.wasm/);
    assert.ok(err.cause instanceof WebAssembly.CompileError);
    return true;
  });
});

test("load() rejects on non-wasm bytes", async () => {
  const garbage = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]);
  await assert.rejects(
    settleWithin(load({ wasmBytes: garbage })),
    /Failed to instantiate redis_lua\.wasm/
  );
});

test("load() rejects on an unresolvable import instead of hanging", async () => {
  const wasm = moduleImporting("env", "__lua_redis_wasm_missing_import__");
  await assert.rejects(settleWithin(load({ wasmBytes: wasm })), (err: Error) => {
    assert.match(err.message, /Failed to instantiate redis_lua\.wasm/);
    assert.ok(err.cause instanceof WebAssembly.LinkError);
    return true;
  });
});

test("load() still succeeds with the real wasm bytes", async () => {
  const wasm = await readWasm();
  const module = await settleWithin(load({ wasmBytes: wasm }));
  const engine = module.createStandalone();
  assert.equal(engine.eval("return 6 * 7"), 42);
});
