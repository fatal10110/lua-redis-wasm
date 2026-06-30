/**
 * @fileoverview Platform-agnostic core of the WASM module loader.
 *
 * Holds everything that does NOT touch a platform builtin: the Emscripten
 * export/import types, the co-located asset URL helpers (browser-safe via
 * `import.meta.url`), and the shared instantiation that injects host callbacks.
 *
 * The platform-specific glue/wasm *loading* lives in `loader.ts` (Node, reads
 * from disk) and `loader.browser.ts` (browser, `fetch`). Conditional `exports`
 * in package.json route consumers to the build that bundles the right one, so a
 * browser bundler never has to resolve a `node:*` builtin.
 *
 * @module loader-core
 */

/**
 * Type definition for the Emscripten module exports — the functions and memory
 * exported by the WASM module (names prefixed with `_` per Emscripten convention).
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
   * Select the compatibility profile (which Redis/Valkey version's Lua sandbox
   * behavior to emulate). Bitmask: 0x1 keep `print`, 0x2 expose `os`, 0x4
   * `server` alias. Call before _init/_reset.
   */
  _set_compat?: (flags: number) => void;

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
 * Type for host-side callback functions imported by WASM (redis.call/pcall/
 * log/sha1hex). The signature varies with the ABI's sret convention.
 */
export type HostImport = (...args: number[]) => number | void | bigint;

/**
 * Factory function type for Emscripten module instantiation.
 */
export type EmscriptenModuleFactory = (options: {
  locateFile?: (path: string) => string;
  wasmBinary?: Uint8Array;
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    successCallback: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void
  ) => WebAssembly.Exports | {};
  [key: string]: unknown;
}) => Promise<WasmExports>;

/**
 * Default location of the WASM binary as a URL href co-located with the bundle
 * (a `file://` URL in Node, the served asset URL in a browser bundle).
 */
export function defaultWasmPath(): string {
  return new URL("./redis_lua.wasm", import.meta.url).href;
}

/**
 * Default location of the Emscripten JS glue module as a URL href co-located
 * with the bundle.
 */
export function defaultModulePath(): string {
  return new URL("./redis_lua.mjs", import.meta.url).href;
}

/**
 * Instantiate an already-loaded Emscripten factory + WASM bytes, injecting the
 * host callbacks into the module's imports. Shared by both platform loaders.
 */
export async function instantiate(
  moduleFactory: EmscriptenModuleFactory,
  wasmBinary: Uint8Array,
  hostImports: Record<string, HostImport>
): Promise<{ module: WasmExports; exports: WasmExports }> {
  const module = await moduleFactory({
    // wasmBinary + the custom instantiateWasm below fully drive instantiation,
    // so locateFile is never consulted for the .wasm — pass other files through.
    locateFile: (file) => file,
    wasmBinary,

    // Custom instantiation to inject host imports.
    instantiateWasm(imports, successCallback) {
      const env = (imports.env as Record<string, WebAssembly.ImportValue>) || {};
      imports.env = { ...env, ...hostImports } as WebAssembly.ModuleImports;

      // Also add to WASI namespace for compatibility.
      imports.wasi_snapshot_preview1 = imports.env;

      WebAssembly.instantiate(wasmBinary, imports).then((result) => {
        const instantiated = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
        successCallback(instantiated.instance, instantiated.module);
      });

      // Return empty object to signal async instantiation.
      return {};
    }
  });

  return { module, exports: module };
}
