import typescript from "@rollup/plugin-typescript";
import resolve from "@rollup/plugin-node-resolve";
import commonjs from "@rollup/plugin-commonjs";
import dts from "rollup-plugin-dts";

const external = [
  "node:fs",
  "node:fs/promises",
  "node:path",
  "node:url",
  "node:crypto",
  /\.wasm$/,
  /\.mjs$/,
];

export default [
  // Main build (ESM + CJS)
  {
    input: "./src/index.ts",
    output: [
      {
        file: "dist/index.mjs",
        format: "esm",
        sourcemap: true,
      },
      {
        file: "dist/index.cjs",
        format: "cjs",
        sourcemap: true,
      },
    ],
    external,
    plugins: [
      resolve({
        preferBuiltins: true,
      }),
      commonjs(),
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        declarationDir: "./dist",
        sourceMap: true,
      }),
    ],
  },
  // Bundled declaration file
  {
    input: "./dist/index.d.ts",
    output: {
      file: "dist/index.d.ts",
      format: "es",
    },
    external,
    plugins: [dts()],
  },
];
