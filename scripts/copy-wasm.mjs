import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const buildDir = path.join(rootDir, "wasm", "build");
const distDir = path.join(rootDir, "dist");

// Both flavors ship: the default binary and the debug flavor (Asyncify + Lua
// debugger) used by load({ debug: true }).
const assets = [
  "redis_lua.wasm",
  "redis_lua.mjs",
  "redis_lua.debug.wasm",
  "redis_lua.debug.mjs",
];

await fs.mkdir(distDir, { recursive: true });

for (const asset of assets) {
  const source = path.join(buildDir, asset);
  try {
    await fs.copyFile(source, path.join(distDir, asset));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to copy ${asset} from ${source}: ${message}`);
  }
}
