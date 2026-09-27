import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

const run = promisify(execFile);

const bundle = path.resolve(process.cwd(), "dist/index.browser.mjs");

function firstExisting(candidates: string[]): string {
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(`File not found. Checked: ${candidates.join(", ")}`);
  }
  return found;
}

// The browser bundle is a build output (`npm run build:ts`). CI builds it before
// the tests, so it must be there; locally the test is skipped if it is missing.
// Tests do not rebuild it: after changing src/, run `npm run build:ts` again or
// this test checks a stale bundle.
const missing = !fs.existsSync(bundle);
if (missing && process.env.CI) {
  throw new Error(`${bundle} not found: run \`npm run build:ts\` before the tests`);
}

test(
  "browser bundle imports without a global Buffer and runs once one is installed",
  {
    skip:
      missing &&
      "dist/index.browser.mjs not built: run `npm run build:ts` (and again after changing src/)"
  },
  async () => {
    const wasmPath = firstExisting([
      path.resolve(process.cwd(), "dist/redis_lua.wasm"),
      path.resolve(process.cwd(), "wasm/build/redis_lua.wasm")
    ]);
    const gluePath = firstExisting([
      path.resolve(process.cwd(), "dist/redis_lua.mjs"),
      path.resolve(process.cwd(), "wasm/build/redis_lua.mjs")
    ]);

    // A fresh process, so removing globals does not affect the test runner.
    // The bundle is imported with no `Buffer`, `process` or `global`, as in a
    // browser (so the glue also takes its non-Node branch); the `Buffer`
    // polyfill is installed only after the import, as a static import forces.
    const child = `
      import { readFile } from "node:fs/promises";
      const wasmBytes = new Uint8Array(await readFile(${JSON.stringify(wasmPath)}));
      const log = console.log;
      delete globalThis.Buffer;
      delete globalThis.process;
      delete globalThis.global;
      const { LuaEngine } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
      for (const name of ["Buffer", "process", "global"]) {
        if (name in globalThis) throw new Error(name + " reappeared");
      }

      globalThis.Buffer = (await import("node:buffer")).Buffer;
      const engine = await LuaEngine.create({
        wasmBytes,
        modulePath: ${JSON.stringify(pathToFileURL(gluePath).href)},
        host: {
          redisCall: (args) => Buffer.concat([Buffer.from("got:"), args[1]]),
          redisPcall: (args) => Buffer.concat([Buffer.from("got:"), args[1]]),
          log: () => {}
        }
      });
      const reply = engine.evalWithArgs(
        "return {redis.call('GET', KEYS[1]), ARGV[1]}",
        [Buffer.from("k")],
        [Buffer.from("a\\x00b")]
      );
      const error = engine.eval("error('ERR boom', 0)");
      log(JSON.stringify({
        reply: reply.map((b) => b.toString("latin1")),
        error: { err: error.err.toString(), code: error.code.toString() }
      }));
    `;

    const { stdout } = await run(
      process.execPath,
      ["--input-type=module", "-e", child],
      { timeout: 30_000 }
    );
    assert.deepEqual(JSON.parse(stdout), {
      reply: ["got:k", "a\x00b"],
      error: { err: "boom", code: "ERR" }
    });
  }
);
