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

  /** Initialize the Lua VM. Returns 0 on success. */
  _init: () => number;

  /** Reset Lua state to initial configuration. Returns 0 on success. */
  _reset: () => number;

  /**
   * Evaluate a Lua script buffer. The PtrLen result is returned through the
   * struct-return pointer (clang's wasm32 C ABI): the 8-byte `{ptr, len}`
   * reply descriptor is written at `retPtr`.
   * @param retPtr - Pointer to an 8-byte slot receiving the PtrLen result
   * @param ptr - Pointer to script bytes in linear memory
   * @param len - Script byte length
   */
  _eval: (retPtr: number, ptr: number, len: number) => void;

  /**
   * Evaluate a Lua script with KEYS/ARGV injection. The PtrLen result is
   * written at `retPtr`, as for `_eval`.
   * @param retPtr - Pointer to an 8-byte slot receiving the PtrLen result
   * @param scriptPtr - Pointer to script bytes
   * @param scriptLen - Script byte length
   * @param argsPtr - Pointer to encoded ArgArray (KEYS + ARGV)
   * @param argsLen - ArgArray byte length
   * @param keysCount - Number of KEYS entries (rest are ARGV)
   */
  _eval_with_args: (
    retPtr: number,
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number
  ) => void;

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
   * Caller of the redis.call/pcall currently dispatched to the host: pointer to
   * its NUL-terminated chunk source (0 when unknown) and its line (-1 for a C
   * frame). Only meaningful inside host_redis_call/pcall.
   */
  _current_call_source?: () => number;
  _current_call_line?: () => number;

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
 * log/setresp/sha1hex/props). Every import returns its PtrLen result through a
 * struct-return pointer passed as the first argument (see docs/abi.md).
 */
export type HostImport = (...args: number[]) => void;

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
  // The Emscripten glue wraps `instantiateWasm` in a promise that only ever
  // resolves (via successCallback) — it has no failure path. If instantiation
  // fails (corrupt bytes, import mismatch) the factory promise would never
  // settle, so surface the failure through a separate promise and race them.
  let failInstantiation!: (reason: unknown) => void;
  const instantiationFailed = new Promise<never>((_, reject) => {
    failInstantiation = reject;
  });

  const modulePromise = moduleFactory({
    // wasmBinary + the custom instantiateWasm below fully drive instantiation,
    // so locateFile is never consulted for the .wasm — pass other files through.
    locateFile: (file) => file,
    wasmBinary,

    // Custom instantiation to inject host imports.
    instantiateWasm(imports, successCallback) {
      // Host callbacks live in `env` (declared with import_module("env") in
      // wasm/include/abi.h). The WASI namespace (fd_write, clock_time_get, ...)
      // is left exactly as the glue provides it.
      const env = (imports.env as Record<string, WebAssembly.ImportValue>) || {};
      imports.env = { ...env, ...hostImports } as WebAssembly.ModuleImports;

      WebAssembly.instantiate(wasmBinary, imports)
        .then((result) => {
          const instantiated = result as unknown as WebAssembly.WebAssemblyInstantiatedSource;
          successCallback(instantiated.instance, instantiated.module);
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          failInstantiation(
            new Error(`Failed to instantiate redis_lua.wasm: ${detail}`, { cause: err })
          );
        });

      // Return empty object to signal async instantiation.
      return {};
    }
  });

  const module = await Promise.race([modulePromise, instantiationFailed]);
  return { module, exports: module };
}
