import fs from "node:fs/promises";
import path from "node:path";
import { LuaWasmEngine } from "../index.js";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

function bufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

async function main(): Promise<void> {
  const wasmPath = path.resolve(process.cwd(), "../wasm/build/redis_lua.wasm");
  try {
    await fs.access(wasmPath);
  } catch {
    throw new Error(`WASM file not found at ${wasmPath}. Build it first.`);
  }

  const engine = await LuaWasmEngine.create({
    wasmPath,
    host: {
      redisCall(args) {
        const command = args[0]?.toString("utf8").toUpperCase();
        if (command === "PING") {
          return { ok: Buffer.from("PONG", "utf8") };
        }
        if (command === "ECHO" && args[1]) {
          return Buffer.from(args[1]);
        }
        return { err: Buffer.from("ERR unknown command", "utf8") };
      },
      redisPcall(args) {
        const command = args[0]?.toString("utf8").toUpperCase();
        if (command === "PING") {
          return { ok: Buffer.from("PONG", "utf8") };
        }
        if (command === "ECHO" && args[1]) {
          return Buffer.from(args[1]);
        }
        return { err: Buffer.from("ERR unknown command", "utf8") };
      },
      log(_level, _message) {}
    }
  });

  const mathResult = engine.eval("return 1+1");
  assert(mathResult === 2, "eval: expected 2");

  const pingResult = engine.eval("return redis.call('PING')");
  assert(
    typeof pingResult === "object" && pingResult !== null && "ok" in pingResult,
    "redis.call: expected status reply"
  );
  assert(
    bufferEqual((pingResult as { ok: Buffer }).ok, Buffer.from("PONG", "utf8")),
    "redis.call: expected PONG"
  );

  const key = Buffer.from([0x00, 0x01]);
  const arg = Buffer.from([0x02, 0x00, 0x03]);
  const binResult = engine.evalWithArgs("return KEYS[1] .. ARGV[1]", [key], [arg]);
  assert(Buffer.isBuffer(binResult), "evalWithArgs: expected Buffer");
  const expected = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]);
  assert(bufferEqual(binResult as Buffer, expected), "evalWithArgs: binary mismatch");

  console.log("host test: OK");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
