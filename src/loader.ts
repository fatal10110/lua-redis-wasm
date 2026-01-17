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

import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LoadOptions } from "./types.js";

/** Directory containing this module, resolved at load time */
const currentDir = path.dirname(fileURLToPath(import.meta.url));

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
 * Resolves the first existing path from a list of candidates.
 *
 * Used for fallback path resolution - tries each candidate in order
 * and returns the first one that exists on the filesystem.
 *
 * @param candidates - Array of file paths to check
 * @returns First existing path, or first candidate if none exist
 */
function resolveExistingPath(candidates: string[]): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Returns the default path to the WASM binary.
 *
 * Checks for the bundled WASM file in the dist/ directory first,
 * then falls back to wasm/build/ for development environments.
 *
 * @returns Absolute path to the WASM binary
 */
export function defaultWasmPath(): string {
  const here = currentDir;
  return resolveExistingPath([
    path.resolve(here, "./redis_lua.wasm"),
    path.resolve(here, "../wasm/build/redis_lua.wasm")
  ]);
}

/**
 * Returns the default path to the Emscripten JS glue module.
 *
 * Checks for the bundled module in dist/ first, then falls back
 * to wasm/build/ for development environments.
 *
 * @returns Absolute path to the JS module
 */
export function defaultModulePath(): string {
  const here = currentDir;
  return resolveExistingPath([
    path.resolve(here, "./redis_lua.mjs"),
    path.resolve(here, "../wasm/build/redis_lua.mjs")
  ]);
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
  // Resolve module and WASM paths
  const modulePath = options.modulePath ?? defaultModulePath();
  const moduleUrl = pathToFileURL(modulePath).href;
  // Dynamic import works in both ESM and CJS (Node.js 12+)
  const imported = await import(moduleUrl);
  const moduleFactory = (imported.default ?? imported) as EmscriptenModuleFactory;
  const wasmPath = options.wasmPath ?? defaultWasmPath();

  // Load WASM binary from provided bytes or file
  const wasmBinary = options.wasmBytes
    ? options.wasmBytes
    : new Uint8Array(await fsPromises.readFile(wasmPath));

  // Instantiate the Emscripten module with custom WASM instantiation
  const module = await moduleFactory({
    // Override file location for WASM loading
    locateFile: (file) => {
      if (file.endsWith(".wasm")) {
        return wasmPath;
      }
      return file;
    },
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
