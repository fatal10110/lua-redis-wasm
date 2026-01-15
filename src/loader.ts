import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EngineOptions, StandaloneOptions } from "./types.js";

// Emscripten module exports we rely on (functions are underscore-prefixed).
export type WasmExports = {
  HEAPU8: Uint8Array;
  getTempRet0?: () => number;
  _init: () => number;
  _reset: () => number;
  _eval: (ptr: number, len: number, retPtr?: number) =>
    | bigint
    | number[]
    | { ptr: number; len: number }
    | number
    | void;
  _eval_with_args: (
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number,
    retPtr?: number
  ) => bigint | number[] | { ptr: number; len: number } | number | void;
  _set_limits?: (maxFuel: number, maxReplyBytes: number, maxArgBytes: number) => void;
  _alloc: (size: number) => number;
  _free_mem: (ptr: number) => void;
};

// Host imports follow Emscripten conventions; some use sret (hidden return ptr).
export type HostImport = (...args: number[]) => number | void | bigint;

type EmscriptenModuleFactory = (options: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => WebAssembly.Exports | {}; 
  [key: string]: unknown;
}) => Promise<WasmExports>;

function resolveExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

export function defaultWasmPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return resolveExistingPath([
    path.resolve(here, "./redis_lua.wasm"),
    path.resolve(here, "../wasm/build/redis_lua.wasm")
  ]);
}

export function defaultModulePath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return resolveExistingPath([
    path.resolve(here, "./redis_lua.mjs"),
    path.resolve(here, "../wasm/build/redis_lua.mjs")
  ]);
}

// Module loader for the Emscripten-generated JS glue.
export async function loadModule(
  options: EngineOptions | StandaloneOptions,
  hostImports: Record<string, HostImport>
): Promise<{ module: WasmExports; exports: WasmExports }> {
  const modulePath = options.modulePath ?? defaultModulePath();
  const moduleUrl = pathToFileURL(modulePath).href;
  const moduleFactory = (await import(moduleUrl)).default as EmscriptenModuleFactory;
  const wasmPath = options.wasmPath ?? defaultWasmPath();
  const wasmBinary = options.wasmBytes
    ? options.wasmBytes
    : new Uint8Array(await fsPromises.readFile(wasmPath));

  const module = await moduleFactory({
    locateFile: (file) => {
      if (file.endsWith(".wasm")) {
        return wasmPath;
      }
      return file;
    },
    wasmBinary,
    instantiateWasm(imports, successCallback) {
      // Inject host callbacks into the wasm import namespace.
      const env = (imports.env as Record<string, WebAssembly.ImportValue>) || {};
      imports.env = { ...env, ...hostImports } as WebAssembly.ModuleImports;
      imports.wasi_snapshot_preview1 = imports.env;
      WebAssembly.instantiate(wasmBinary, imports).then((result) => {
        const instantiated = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
        successCallback(instantiated.instance, instantiated.module);
      });
      return {};
    }
  });

  return { module, exports: module };
}
