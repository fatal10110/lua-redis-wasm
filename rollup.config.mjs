import { fileURLToPath } from "node:url";
import alias from "@rollup/plugin-alias";
import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import dts from "rollup-plugin-dts";

const abs = (rel) => fileURLToPath(new URL(rel, import.meta.url));

// The Emscripten glue + .wasm are emitted/served as co-located assets, never
// inlined; keep them external in every build.
const assetExternal = [/\.wasm$/, /\.mjs$/];

// Node build additionally keeps the `node:*` builtins its loader dynamic-imports
// external (they're real, available at runtime).
const nodeExternal = [
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:url",
  "node:crypto",
  ...assetExternal,
];

const ts = (declaration) =>
  typescript({
    tsconfig: "./tsconfig.json",
    declaration,
    declarationMap: declaration,
    declarationDir: declaration ? "./dist" : undefined,
    sourceMap: true,
  });

export default [
  // Node build (ESM + CJS) — `./loader.js` resolves to the Node loader.ts.
  // Emits the declarations the dts bundle below consumes.
  {
    input: "./src/index.ts",
    output: [
      { file: "dist/index.node.mjs", format: "esm", sourcemap: true },
      { file: "dist/index.node.cjs", format: "cjs", sourcemap: true },
    ],
    external: nodeExternal,
    plugins: [resolve({ preferBuiltins: true }), commonjs(), ts(true)],
  },
  // Browser build (ESM) — alias `./loader.js` to the fetch-based browser loader
  // so no `node:*` builtin enters the graph. No declarations (node build emits them).
  {
    input: "./src/index.ts",
    output: { file: "dist/index.browser.mjs", format: "esm", sourcemap: true },
    external: assetExternal,
    plugins: [
      alias({
        entries: [
          { find: "./loader.js", replacement: abs("./src/loader.browser.ts") },
        ],
      }),
      resolve({ browser: true }),
      commonjs(),
      ts(false),
    ],
  },
  // Bundled declaration file.
  {
    input: "./dist/index.d.ts",
    output: { file: "dist/index.d.ts", format: "es" },
    external: assetExternal,
    plugins: [dts()],
  },
];
