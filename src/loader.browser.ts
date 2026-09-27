/**
 * @fileoverview Browser WASM module loader.
 *
 * The browser build's `./loader.js` (rollup aliases this file in for the browser
 * target via conditional `exports`). Contains **no** `node:*` imports: the glue
 * is a literal `import("./redis_lua.mjs")` the bundler emits as an asset, and the
 * `.wasm` is fetched from its co-located URL. A browser bundler can therefore put
 * this module in the graph without resolving any Node builtin — no `fs`/`net`
 * stub needed downstream.
 *
 * @module loader.browser
 */

import type { LoadOptions } from "./types.js";
import {
  compiledModule,
  instantiate,
  defaultModulePath,
  defaultWasmPath,
  type EmscriptenModuleFactory,
  type HostImport,
  type WasmExports,
  type WasmSource
} from "./loader-core.js";

export { defaultModulePath, defaultWasmPath };
export type { HostImport, WasmExports };

/** Load the Emscripten glue factory as a co-located (or explicit URL) asset. */
async function loadGlueFactory(
  options: LoadOptions
): Promise<EmscriptenModuleFactory> {
  if (options.modulePath) {
    // Explicit URL (e.g. a jsdelivr CDN URL). Fully dynamic so the bundler
    // doesn't try to resolve/emit it; @vite-ignore silences the warning.
    const imported = await import(/* @vite-ignore */ options.modulePath);
    return (imported.default ?? imported) as EmscriptenModuleFactory;
  }
  // Bundled default: literal specifier so the bundler emits + resolves the glue
  // as a co-located asset.
  // @ts-ignore - Emscripten glue has no type declarations; resolved by the bundler.
  const imported = await import("./redis_lua.mjs");
  return (imported.default ?? imported) as EmscriptenModuleFactory;
}

/**
 * Where the WASM binary comes from: `options.wasmBytes`, or its URL (fetched
 * only on a compiled-module cache miss).
 */
function wasmSource(options: LoadOptions): WasmSource {
  if (options.wasmBytes) {
    return options.wasmBytes;
  }
  // Explicit URL (e.g. jsdelivr) wins; otherwise the co-located bundled asset.
  const wasmUrl = options.wasmPath ?? new URL("./redis_lua.wasm", import.meta.url).href;
  return {
    location: wasmUrl,
    read: async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch redis_lua.wasm: ${response.status} ${response.statusText}`
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

/**
 * Loads and instantiates the Emscripten WASM module with host imports
 * (browser). The compiled module is cached (see `compiledModule`); each call
 * creates a new instance.
 *
 * @param options - Engine or standalone options with optional custom paths
 * @param hostImports - Map of host callback functions to inject
 * @returns Object containing the instantiated module and exports
 */
export async function loadModule(
  options: LoadOptions,
  hostImports: Record<string, HostImport>
): Promise<{ module: WasmExports; exports: WasmExports }> {
  const moduleFactory = await loadGlueFactory(options);
  const wasmModule = await compiledModule(wasmSource(options));
  return instantiate(moduleFactory, wasmModule, hostImports);
}
