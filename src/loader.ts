/**
 * @fileoverview WASM module loader for the Redis Lua engine.
 *
 * This module handles loading and instantiating the Emscripten-compiled
 * WASM module. It provides:
 * - Path resolution for bundled WASM and JS glue files
 * - Host import injection for redis.call/pcall/log callbacks
 * - Module instantiation with custom configuration
 *
 * ## Architecture
 *
 * The loader bridges between Emscripten's module system and our host:
 *
 * ```
 * ┌─────────────────────┐
 * │   Host (Node.js)    │
 * │  - hostImports      │
 * │  - readBytes/write  │
 * └──────────┬──────────┘
 *            │ instantiateWasm
 *            ▼
 * ┌─────────────────────┐
 * │  Emscripten Glue    │
 * │  (redis_lua.mjs)    │
 * └──────────┬──────────┘
 *            │
 *            ▼
 * ┌─────────────────────┐
 * │    WASM Module      │
 * │  (redis_lua.wasm)   │
 * │  - Lua 5.1 VM       │
 * │  - Redis API layer  │
 * └─────────────────────┘
 * ```
 *
 * @module loader
 */

import type { LoadOptions } from "./types.js";

// Browser-safe by construction: NO top-level `node:*` imports. The Node-only
// path resolution and filesystem reads are loaded via dynamic `import("node:*")`
// inside `isNode` branches, so a browser bundler (Vite/Rollup) never has to
// resolve a Node builtin to put this module in the graph. The browser branch
// instead resolves the co-located Emscripten glue + `.wasm` via `import.meta.url`
// so the bundler emits them as assets.
const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null;

/**
 * Type definition for the Emscripten module exports.
 *
 * These are the functions and memory exported by the WASM module.
 * Function names are prefixed with underscore following Emscripten convention.
 *
 * ## Memory
 * - `HEAPU8` - Direct access to WASM linear memory as Uint8Array
 *
 * ## Lifecycle
 * - `_init()` - Initialize Lua VM and preload modules
 * - `_reset()` - Clear Lua state and reinitialize globals
 *
 * ## Evaluation
 * - `_eval(ptr, len)` - Evaluate a Lua script
 * - `_eval_with_args(...)` - Evaluate with KEYS/ARGV injection
 *
 * ## Memory Management
 * - `_alloc(size)` - Allocate bytes in linear memory
 * - `_free_mem(ptr)` - Free allocated memory
 *
 * ## Configuration
 * - `_set_limits(fuel, reply, arg)` - Set runtime limits
 */
export type WasmExports = {
  /** Direct access to WASM linear memory */
  HEAPU8: Uint8Array;

  /** Legacy Emscripten helper for multi-value returns */
  getTempRet0?: () => number;

  /** Initialize the Lua VM. Returns 0 on success. */
  _init: () => number;

  /** Reset Lua state to initial configuration. Returns 0 on success. */
  _reset: () => number;

  /**
   * Evaluate a Lua script buffer.
   * @param ptr - Pointer to script bytes in linear memory
   * @param len - Script byte length
   * @param retPtr - Optional sret pointer for return value (ABI-dependent)
   * @returns PtrLen result in various formats depending on ABI
   */
  _eval: (ptr: number, len: number, retPtr?: number) =>
    | bigint
    | number[]
    | { ptr: number; len: number }
    | number
    | void;

  /**
   * Evaluate a Lua script with KEYS/ARGV injection.
   * @param scriptPtr - Pointer to script bytes
   * @param scriptLen - Script byte length
   * @param argsPtr - Pointer to encoded ArgArray (KEYS + ARGV)
   * @param argsLen - ArgArray byte length
   * @param keysCount - Number of KEYS entries (rest are ARGV)
   * @param retPtr - Optional sret pointer
   * @returns PtrLen result
   */
  _eval_with_args: (
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number,
    retPtr?: number
  ) => bigint | number[] | { ptr: number; len: number } | number | void;

  /**
   * Configure runtime limits.
   * @param maxFuel - Instruction budget (0 = unlimited)
   * @param maxReplyBytes - Maximum reply size (0 = unlimited)
   * @param maxArgBytes - Maximum argument size (0 = unlimited)
   */
  _set_limits?: (maxFuel: number, maxReplyBytes: number, maxArgBytes: number) => void;

  /**
   * Allocate memory in WASM linear memory.
   * @param size - Number of bytes to allocate
   * @returns Pointer to allocated memory
   */
  _alloc: (size: number) => number;

  /**
   * Free previously allocated memory.
   * @param ptr - Pointer to memory to free
   */
  _free_mem: (ptr: number) => void;
};

/**
 * Type for host-side callback functions imported by WASM.
 *
 * These functions implement the redis.call/pcall/log/sha1hex API
 * and are called from the WASM module. The signature varies based
 * on whether the ABI uses sret (structure return) convention:
 *
 * - Direct return: `(ptr, len) => bigint`
 * - Sret: `(retPtr, ptr, len) => void`
 *
 * @param args - Variable arguments depending on the function
 * @returns Result value or void for sret functions
 */
export type HostImport = (...args: number[]) => number | void | bigint;

/**
 * Factory function type for Emscripten module instantiation.
 */
type EmscriptenModuleFactory = (options: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => WebAssembly.Exports | {};
  [key: string]: unknown;
}) => Promise<WasmExports>;

/**
 * Node-only: resolve a co-located asset, preferring the built dist/ layout and
 * falling back to the dev wasm/build/ layout. Dynamic-imports node builtins so
 * this module stays browser-safe.
 *
 * @param file - Bare asset filename, e.g. "redis_lua.wasm"
 * @returns Absolute filesystem path to the first existing candidate
 */
async function nodeAssetPath(file: string): Promise<string> {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of [`./${file}`, `../wasm/build/${file}`]) {
    const candidate = path.resolve(here, rel);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.resolve(here, `./${file}`);
}

/**
 * Returns the default location of the WASM binary as a URL href co-located with
 * this module (e.g. `file://.../dist/redis_lua.wasm` in Node, the served asset
 * URL in a browser bundle). String-returning and browser-safe.
 *
 * @returns URL href of the bundled WASM binary
 */
export function defaultWasmPath(): string {
  return new URL("./redis_lua.wasm", import.meta.url).href;
}

/**
 * Returns the default location of the Emscripten JS glue module as a URL href
 * co-located with this module. String-returning and browser-safe.
 *
 * @returns URL href of the bundled JS glue module
 */
export function defaultModulePath(): string {
  return new URL("./redis_lua.mjs", import.meta.url).href;
}

/**
 * Loads and instantiates the Emscripten WASM module with host imports.
 *
 * This is the core module loading function. It:
 * 1. Loads the Emscripten JS glue module
 * 2. Reads the WASM binary (from file or provided bytes)
 * 3. Injects host callback functions into the WASM imports
 * 4. Instantiates the WebAssembly module
 *
 * The host imports are injected into both `env` and `wasi_snapshot_preview1`
 * namespaces for compatibility with different Emscripten configurations.
 *
 * @param options - Engine or standalone options with optional custom paths
 * @param hostImports - Map of host callback functions to inject
 * @returns Object containing the instantiated module and exports
 *
 * @example
 * ```typescript
 * const hostImports = {
 *   host_redis_call: (retPtr, ptr, len) => { ... },
 *   host_redis_pcall: (retPtr, ptr, len) => { ... },
 *   host_redis_log: (level, ptr, len) => { ... },
 *   host_sha1hex: (retPtr, ptr, len) => { ... }
 * };
 *
 * const { module, exports } = await loadModule(options, hostImports);
 * ```
 */
export async function loadModule(
  options: LoadOptions,
  hostImports: Record<string, HostImport>
): Promise<{ module: WasmExports; exports: WasmExports }> {
  const moduleFactory = await loadGlueFactory(options);
  const wasmBinary = await loadWasmBinary(options);

  // Instantiate the Emscripten module with custom WASM instantiation
  const module = await moduleFactory({
    // wasmBinary + the custom instantiateWasm below fully drive instantiation,
    // so locateFile is never consulted for the .wasm — pass other files through.
    locateFile: (file) => file,
    wasmBinary,

    // Custom instantiation to inject host imports
    instantiateWasm(imports, successCallback) {
      // Merge host callbacks into the env namespace
      const env = (imports.env as Record<string, WebAssembly.ImportValue>) || {};
      imports.env = { ...env, ...hostImports } as WebAssembly.ModuleImports;

      // Also add to WASI namespace for compatibility
      imports.wasi_snapshot_preview1 = imports.env;

      // Perform async instantiation
      WebAssembly.instantiate(wasmBinary, imports).then((result) => {
        const instantiated = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
        successCallback(instantiated.instance, instantiated.module);
      });

      // Return empty object to signal async instantiation
      return {};
    }
  });

  return { module, exports: module };
}

/**
 * Load the Emscripten glue module factory.
 * - Browser: literal `import("./redis_lua.mjs")` so the bundler statically emits
 *   and resolves the glue as an asset.
 * - Node: dynamic import of the resolved `file://` URL (dist/ or dev wasm/build/),
 *   honoring an explicit `options.modulePath`.
 */
async function loadGlueFactory(
  options: LoadOptions
): Promise<EmscriptenModuleFactory> {
  if (!isNode) {
    // @ts-ignore - Emscripten glue has no type declarations; resolved by the bundler.
    const imported = await import("./redis_lua.mjs");
    return (imported.default ?? imported) as EmscriptenModuleFactory;
  }
  const { pathToFileURL } = await import("node:url");
  const modulePath = options.modulePath ?? (await nodeAssetPath("redis_lua.mjs"));
  const moduleUrl = /^[a-z]+:\/\//i.test(modulePath)
    ? modulePath
    : pathToFileURL(modulePath).href;
  const imported = await import(moduleUrl);
  return (imported.default ?? imported) as EmscriptenModuleFactory;
}

/**
 * Load the WASM binary bytes.
 * - `options.wasmBytes` always wins (lets callers bypass any file/network read).
 * - Browser: fetch the co-located asset resolved via `import.meta.url`.
 * - Node: read the resolved file (`options.wasmPath`, else dist/ or dev wasm/build/).
 */
async function loadWasmBinary(options: LoadOptions): Promise<Uint8Array> {
  if (options.wasmBytes) {
    return options.wasmBytes;
  }
  if (!isNode) {
    const response = await fetch(new URL("./redis_lua.wasm", import.meta.url));
    if (!response.ok) {
      throw new Error(
        `Failed to fetch redis_lua.wasm: ${response.status} ${response.statusText}`
      );
    }
    return new Uint8Array(await response.arrayBuffer());
  }
  const { readFile } = await import("node:fs/promises");
  const wasmPath = options.wasmPath ?? (await nodeAssetPath("redis_lua.wasm"));
  return new Uint8Array(await readFile(wasmPath));
}
