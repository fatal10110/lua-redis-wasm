import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const wasmSource = path.join(rootDir, "wasm", "build", "redis_lua.wasm");
const moduleSource = path.join(rootDir, "wasm", "build", "redis_lua.mjs");
const distDir = path.join(rootDir, "dist");
const wasmDest = path.join(distDir, "redis_lua.wasm");
const moduleDest = path.join(distDir, "redis_lua.mjs");

await fs.mkdir(distDir, { recursive: true });
try {
  await fs.copyFile(wasmSource, wasmDest);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`Failed to copy WASM from ${wasmSource}: ${message}`);
}

try {
  await fs.copyFile(moduleSource, moduleDest);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  throw new Error(`Failed to copy module from ${moduleSource}: ${message}`);
}
