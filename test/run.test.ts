import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { LuaWasmEngine } from "../src/index.ts";

async function resolveWasmPath(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "dist/redis_lua.wasm"),
    path.resolve(process.cwd(), "wasm/build/redis_lua.wasm")
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`WASM file not found. Checked: ${candidates.join(", ")}`);
}

function bufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

test("eval + redis.call + binary safety + error paths", async () => {
  await resolveWasmPath();
  let lastCallArgs: Buffer[] | null = null;
  let lastPcallArgs: Buffer[] | null = null;

  const engine = await LuaWasmEngine.create({
    host: {
      redisCall(args) {
        lastCallArgs = args.map((arg) => Buffer.from(arg));
        const command = args[0]?.toString("utf8").toUpperCase();
        if (command === "PING") {
          return { ok: Buffer.from("PONG", "utf8") };
        }
        if (command === "ECHO" && args[1]) {
          return Buffer.from(args[1]);
        }
        if (command === "THROW") {
          throw new Error("ERR boom");
        }
        return { err: Buffer.from("ERR unknown command", "utf8") };
      },
      redisPcall(args) {
        lastPcallArgs = args.map((arg) => Buffer.from(arg));
        const command = args[0]?.toString("utf8").toUpperCase();
        if (command === "PING") {
          return { ok: Buffer.from("PONG", "utf8") };
        }
        if (command === "ECHO" && args[1]) {
          return Buffer.from(args[1]);
        }
        if (command === "THROW") {
          throw new Error("ERR boom");
        }
        return { err: Buffer.from("ERR unknown command", "utf8") };
      },
      log() {},
    },
  });

  assert.equal(engine.eval("return 1+1"), 2);

  const pingResult = engine.eval("return redis.call('PING')");
  assert.ok(pingResult && typeof pingResult === "object" && "ok" in pingResult);
  assert.ok(bufferEqual(pingResult.ok, Buffer.from("PONG", "utf8")));

  const key = Buffer.from([0x00, 0x01]);
  const arg = Buffer.from([0x02, 0x00, 0x03]);
  const binResult = engine.evalWithArgs(
    "return KEYS[1] .. ARGV[1]",
    [key],
    [arg]
  );
  assert.ok(Buffer.isBuffer(binResult));
  const expected = Buffer.from([0x00, 0x01, 0x02, 0x00, 0x03]);
  assert.ok(bufferEqual(binResult, expected));

  const echoBinary = Buffer.from([0x61, 0x00, 0x62]);
  const echoResult = engine.eval(
    "return redis.call('ECHO', string.char(97,0,98))"
  );
  assert.ok(Buffer.isBuffer(echoResult));
  assert.ok(bufferEqual(echoResult, echoBinary));
  assert.ok(lastCallArgs && lastCallArgs.length >= 2);
  assert.ok(bufferEqual(lastCallArgs[1], echoBinary));

  const callErr = engine.eval("return redis.call('THROW')");
  assert.ok(callErr && typeof callErr === "object" && "err" in callErr);

  const pcallErr = engine.eval("return redis.pcall('THROW')");
  assert.ok(pcallErr && typeof pcallErr === "object" && "err" in pcallErr);
  assert.ok(lastPcallArgs && lastPcallArgs.length >= 1);
});

test("limits: maxArgBytes", async () => {
  await resolveWasmPath();
  const limitedEngine = await LuaWasmEngine.create({
    limits: {
      maxArgBytes: 4,
    },
    host: {
      redisCall() {
        return { ok: Buffer.from("OK", "utf8") };
      },
      redisPcall() {
        return { ok: Buffer.from("OK", "utf8") };
      },
      log() {},
    },
  });

  const limitResult = limitedEngine.evalWithArgs(
    "return 1",
    [Buffer.from("a")],
    [Buffer.from("b")]
  );
  assert.ok(
    limitResult && typeof limitResult === "object" && "err" in limitResult
  );
});
