/**
 * @fileoverview Node.js WASM module loader.
 *
 * The Node build's `./loader.js`: resolves the co-located Emscripten glue +
 * `.wasm` on disk and reads them with `node:fs`. The browser counterpart is
 * `loader.browser.ts` (fetch-based, zero `node:*`); rollup swaps which one is
 * bundled per target via conditional `exports`. Dev/test (tsx) and the Node
 * build resolve `./loader.js` straight to this file.
 *
 * @module loader
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

/**
 * Resolve a co-located asset, preferring the built `dist/` layout and falling
 * back to the dev `wasm/build/` layout.
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

/** Load the Emscripten glue module factory from the resolved `file://` URL. */
async function loadGlueFactory(
  options: LoadOptions
): Promise<EmscriptenModuleFactory> {
  const { pathToFileURL } = await import("node:url");
  const modulePath = options.modulePath ?? (await nodeAssetPath("redis_lua.mjs"));
  const moduleUrl = /^[a-z]+:\/\//i.test(modulePath)
    ? modulePath
    : pathToFileURL(modulePath).href;
  const imported = await import(moduleUrl);
  return (imported.default ?? imported) as EmscriptenModuleFactory;
}

/**
 * Where the WASM binary comes from: `options.wasmBytes`, or the file on disk
 * (read only on a compiled-module cache miss).
 */
async function wasmSource(options: LoadOptions): Promise<WasmSource> {
  if (options.wasmBytes) {
    return options.wasmBytes;
  }
  const path = await import("node:path");
  const wasmPath = options.wasmPath ?? (await nodeAssetPath("redis_lua.wasm"));
  // A `file://` URL and the plain path name the same file: key both alike.
  const location = /^file:\/\//i.test(wasmPath)
    ? (await import("node:url")).fileURLToPath(wasmPath)
    : path.resolve(wasmPath);
  return {
    location,
    read: async () => {
      const { readFile } = await import("node:fs/promises");
      return new Uint8Array(await readFile(location));
    }
  };
}

/**
 * Loads and instantiates the Emscripten WASM module with host imports (Node).
 * The compiled module is cached (see `compiledModule`); each call creates a
 * new instance.
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
  const wasmModule = await compiledModule(await wasmSource(options));
  return instantiate(moduleFactory, wasmModule, hostImports);
}
