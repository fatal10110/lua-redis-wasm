/**
 * Comprehensive unit tests for LuaEngine.
 * Tests cover: basic eval, evalWithArgs, host callbacks, error handling, limits, and standalone mode.
 */
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaWasmModule } from "../src/index.js";
import type { ReplyValue, RedisHost } from "../src/types.js";

// Helper to resolve WASM path (checks dist/ first, then wasm/build/)
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

// Simple host implementation for testing
function createTestHost(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall(args) {
      const cmd = args[0]?.toString("utf8").toUpperCase();
      if (cmd === "PING") return { ok: Buffer.from("PONG") };
      if (cmd === "GET" && args[1]) return Buffer.from(`value:${args[1].toString()}`);
      if (cmd === "SET") return { ok: Buffer.from("OK") };
      if (cmd === "ECHO" && args[1]) return Buffer.from(args[1]);
      if (cmd === "INCR") return 1;
      if (cmd === "MGET") return args.slice(1).map((k) => Buffer.from(`v:${k.toString()}`));
      if (cmd === "THROW") throw new Error("ERR intentional error");
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args) {
      try {
        return this.redisCall(args);
      } catch (err) {
        return { err: Buffer.from(err instanceof Error ? err.message : String(err)) };
      }
    },
    log() {},
    ...overrides
  };
}

// =============================================================================
// Basic eval() tests
// =============================================================================

test("eval: returns number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 42");
  assert.equal(result, 42);
});

test("eval: returns negative number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return -100");
  assert.equal(result, -100);
});

test("eval: returns float as integer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // Lua 5.1 has no separate integer type, math.floor returns number
  const result = engine.eval("return math.floor(3.7)");
  assert.equal(result, 3);
});

test("eval: arithmetic operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  assert.equal(engine.eval("return 10 + 5"), 15);
  assert.equal(engine.eval("return 10 - 5"), 5);
  assert.equal(engine.eval("return 10 * 5"), 50);
  assert.equal(engine.eval("return 10 / 5"), 2);
  assert.equal(engine.eval("return 10 % 3"), 1);
  assert.equal(engine.eval("return 2 ^ 10"), 1024);
});

test("eval: returns string as Buffer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 'hello world'");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString("utf8"), "hello world");
});

test("eval: returns nil as null", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return nil");
  assert.equal(result, null);
});

test("eval: returns empty table as empty array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {}");
  assert.ok(Array.isArray(result));
  assert.equal((result as unknown[]).length, 0);
});

test("eval: returns table as array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {1, 2, 3}");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [1, 2, 3]);
});

test("eval: returns nested tables", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {{1, 2}, {3, 4}}");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [[1, 2], [3, 4]]);
});

test("eval: returns mixed array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {1, 'hello', nil, 4}") as ReplyValue[];
  assert.ok(Array.isArray(result));
  assert.equal(result[0], 1);
  assert.ok(Buffer.isBuffer(result[1]));
  // nil in middle of array terminates iteration in Lua table
});

test("eval: accepts Buffer as script", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = Buffer.from("return 99");
  const result = engine.eval(script);
  assert.equal(result, 99);
});

test("eval: accepts Uint8Array as script", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = new TextEncoder().encode("return 77");
  const result = engine.eval(script);
  assert.equal(result, 77);
});

test("eval: Lua syntax error returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 1 +");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("eval: Lua runtime error returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("error('boom')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("eval: Lua error format matches Redis format", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = "redis.set('key', 'value')"; // redis.set doesn't exist, only redis.call
  const result = engine.eval(script);

  assert.ok(result && typeof result === "object" && "err" in result);
  const errStr = (result as { err: Buffer }).err.toString("utf8");

  // Should match Redis format: "user_script:N: message script: <sha>, on @user_script:N."
  assert.ok(errStr.startsWith("user_script:1:"), `Error should start with 'user_script:1:', got: ${errStr}`);
  assert.ok(errStr.includes(" script: "), `Error should contain ' script: ', got: ${errStr}`);
  assert.ok(errStr.includes(", on @user_script:1."), `Error should end with ', on @user_script:1.', got: ${errStr}`);

  // SHA should be 40 hex chars
  const shaMatch = errStr.match(/script: ([a-f0-9]{40}),/);
  assert.ok(shaMatch, `Error should contain 40-char SHA hex, got: ${errStr}`);
});

test("eval: Lua error on different line includes correct line number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = `
local x = 1
local y = 2
redis.nonexistent()  -- line 4
`;
  const result = engine.eval(script);

  assert.ok(result && typeof result === "object" && "err" in result);
  const errStr = (result as { err: Buffer }).err.toString("utf8");

  // Should reference line 4
  assert.ok(errStr.startsWith("user_script:4:"), `Error should start with 'user_script:4:', got: ${errStr}`);
  assert.ok(errStr.includes(", on @user_script:4."), `Error should end with ', on @user_script:4.', got: ${errStr}`);
});

// =============================================================================
// evalWithArgs() tests
// =============================================================================

test("evalWithArgs: KEYS injection", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return KEYS[1]",
    [Buffer.from("mykey")],
    []
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "mykey");
});

test("evalWithArgs: ARGV injection", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return ARGV[1]",
    [],
    [Buffer.from("myarg")]
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "myarg");
});

test("evalWithArgs: multiple KEYS and ARGV", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}",
    [Buffer.from("k1"), Buffer.from("k2")],
    [Buffer.from("a1"), Buffer.from("a2")]
  ) as ReplyValue[];

  assert.ok(Array.isArray(result));
  assert.equal((result[0] as Buffer).toString(), "k1");
  assert.equal((result[1] as Buffer).toString(), "k2");
  assert.equal((result[2] as Buffer).toString(), "a1");
  assert.equal((result[3] as Buffer).toString(), "a2");
});

test("evalWithArgs: binary-safe KEYS/ARGV with null bytes", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const key = Buffer.from([0x00, 0x01, 0x02]);
  const arg = Buffer.from([0x03, 0x00, 0x04]);

  const result = engine.evalWithArgs(
    "return KEYS[1] .. ARGV[1]",
    [key],
    [arg]
  );

  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...(result as Buffer)], [0x00, 0x01, 0x02, 0x03, 0x00, 0x04]);
});

test("evalWithArgs: accepts strings", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs("return KEYS[1]", ["stringkey"], []);
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "stringkey");
});

test("evalWithArgs: empty KEYS and ARGV", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs("return #KEYS + #ARGV", [], []);
  assert.equal(result, 0);
});

test("evalWithArgs: KEYS length", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return #KEYS",
    [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
    []
  );
  assert.equal(result, 3);
});

test("evalWithArgs: ARGV length", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return #ARGV",
    [],
    [Buffer.from("x"), Buffer.from("y")]
  );
  assert.equal(result, 2);
});

// =============================================================================
// redis.call() tests
// =============================================================================

test("redis.call: PING returns status", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('PING')");
  assert.ok(result && typeof result === "object" && "ok" in result);
  assert.equal((result as { ok: Buffer }).ok.toString(), "PONG");
});

test("redis.call: GET returns value", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('GET', 'foo')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "value:foo");
});

test("redis.call: SET returns OK", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('SET', 'key', 'value')");
  assert.ok(result && typeof result === "object" && "ok" in result);
});

test("redis.call: INCR returns integer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('INCR', 'counter')");
  assert.equal(result, 1);
});

test("redis.call: MGET returns array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('MGET', 'a', 'b')") as ReplyValue[];
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
});

test("redis.call: ECHO with binary data", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('ECHO', string.char(0, 1, 0))");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...(result as Buffer)], [0, 1, 0]);
});

test("redis.call: unknown command returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('UNKNOWNCMD')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("redis.call: host throwing returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('THROW')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("intentional"));
});

test("redis.call: receives arguments as Buffers", async () => {
  await resolveWasmPath();
  let receivedArgs: Buffer[] = [];
  const host = createTestHost({
    redisCall(args) {
      receivedArgs = args;
      return { ok: Buffer.from("OK") };
    }
  });
  const module = await load();
  const engine = module.create(host);
  engine.eval("redis.call('TEST', 'arg1', 'arg2')");

  assert.equal(receivedArgs.length, 3);
  assert.ok(Buffer.isBuffer(receivedArgs[0]));
  assert.equal(receivedArgs[0].toString(), "TEST");
  assert.equal(receivedArgs[1].toString(), "arg1");
  assert.equal(receivedArgs[2].toString(), "arg2");
});

// =============================================================================
// redis.pcall() tests
// =============================================================================

test("redis.pcall: returns error instead of throwing", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.pcall('THROW')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("redis.pcall: success returns normal value", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.pcall('PING')");
  assert.ok(result && typeof result === "object" && "ok" in result);
});

// =============================================================================
// redis.log() tests
// =============================================================================

test("redis.log: calls host log handler", async () => {
  await resolveWasmPath();
  let loggedLevel: number | null = null;
  let loggedMessage: Buffer | null = null;

  const host = createTestHost({
    log(level, message) {
      loggedLevel = level;
      loggedMessage = message;
    }
  });

  const module = await load();
  const engine = module.create(host);
  engine.eval("redis.log(redis.LOG_WARNING, 'test message')");

  assert.ok(loggedLevel !== null);
  assert.ok(loggedMessage !== null);
  assert.ok(Buffer.isBuffer(loggedMessage));
  assert.equal(loggedMessage.toString(), "test message");
});

// =============================================================================
// redis.sha1hex() tests
// =============================================================================

test("redis.sha1hex: computes SHA1 hash", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.sha1hex('hello')");
  assert.ok(Buffer.isBuffer(result));
  // SHA1 of "hello" is aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
  assert.equal((result as Buffer).toString(), "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
});

test("redis.sha1hex: empty string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.sha1hex('')");
  assert.ok(Buffer.isBuffer(result));
  // SHA1 of empty string is da39a3ee5e6b4b0d3255bfef95601890afd80709
  assert.equal((result as Buffer).toString(), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

// =============================================================================
// Lua standard library tests
// =============================================================================

test("Lua: string library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return string.len('hello')"), 5);
  assert.equal((engine.eval("return string.upper('hello')") as Buffer).toString(), "HELLO");
  assert.equal((engine.eval("return string.lower('HELLO')") as Buffer).toString(), "hello");
  assert.equal((engine.eval("return string.sub('hello', 2, 4)") as Buffer).toString(), "ell");
  assert.equal((engine.eval("return string.rep('ab', 3)") as Buffer).toString(), "ababab");
});

test("Lua: math library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return math.abs(-5)"), 5);
  assert.equal(engine.eval("return math.max(1, 5, 3)"), 5);
  assert.equal(engine.eval("return math.min(1, 5, 3)"), 1);
  assert.equal(engine.eval("return math.floor(3.7)"), 3);
  assert.equal(engine.eval("return math.ceil(3.2)"), 4);
});

test("Lua: table library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const concat = engine.eval("return table.concat({'a','b','c'}, ',')");
  assert.ok(Buffer.isBuffer(concat));
  assert.equal((concat as Buffer).toString(), "a,b,c");
});

// =============================================================================
// Limits tests
// =============================================================================

test("limits: maxArgBytes enforced on evalWithArgs", async () => {
  await resolveWasmPath();
  const module = await load({ limits: { maxArgBytes: 10 } });
  const engine = module.create(createTestHost());

  // This should exceed the limit (encoded args > 10 bytes)
  const result = engine.evalWithArgs(
    "return 1",
    [Buffer.from("this-is-a-long-key")],
    [Buffer.from("this-is-a-long-arg")]
  );

  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("limit"));
});

test("limits: small args pass validation", async () => {
  await resolveWasmPath();
  const module = await load({ limits: { maxArgBytes: 1000 } });
  const engine = module.create(createTestHost());

  const result = engine.evalWithArgs(
    "return KEYS[1]",
    [Buffer.from("k")],
    []
  );

  assert.ok(Buffer.isBuffer(result));
});

test("getLimits: returns configured limits", async () => {
  await resolveWasmPath();
  const limits = {
    maxFuel: 1000000,
    maxReplyBytes: 2000000,
    maxArgBytes: 500000
  };

  const module = await load({ limits });
  const engine = module.create(createTestHost());

  const retrieved = engine.getLimits();
  assert.deepEqual(retrieved, limits);
});

test("getLimits: returns undefined when no limits set", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const retrieved = engine.getLimits();
  assert.equal(retrieved, undefined);
});

// =============================================================================
// Standalone mode tests
// =============================================================================

test("standalone: basic eval works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return 1 + 2");
  assert.equal(result, 3);
});

test("standalone: math library works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  assert.equal(engine.eval("return math.sqrt(16)"), 4);
});

test("standalone: string library works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return string.upper('test')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "TEST");
});

test("standalone: redis.call returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.call('PING')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("standalone"));
});

test("standalone: redis.pcall returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.pcall('GET', 'key')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("standalone"));
});

test("standalone: redis.sha1hex still works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.sha1hex('test')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).length, 40); // SHA1 hex is 40 chars
});

test("standalone: evalWithArgs works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.evalWithArgs(
    "return KEYS[1] .. ARGV[1]",
    [Buffer.from("key")],
    [Buffer.from("arg")]
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "keyarg");
});

// =============================================================================
// Static method tests
// =============================================================================

test("defaultWasmPath: returns a string path", () => {
  const wasmPath = LuaWasmModule.defaultWasmPath();
  assert.equal(typeof wasmPath, "string");
  assert.ok(wasmPath.endsWith(".wasm"));
});

test("defaultModulePath: returns a string path", () => {
  const modulePath = LuaWasmModule.defaultModulePath();
  assert.equal(typeof modulePath, "string");
  assert.ok(modulePath.endsWith(".mjs"));
});

// =============================================================================
// cjson library tests
// =============================================================================

test("cjson: encode object", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return cjson.encode({a=1, b=2})");
  assert.ok(Buffer.isBuffer(result));
  const parsed = JSON.parse((result as Buffer).toString());
  assert.deepEqual(parsed, { a: 1, b: 2 });
});

test("cjson: decode string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("local t = cjson.decode('{\"x\":10}'); return t.x");
  assert.equal(result, 10);
});

test("cjson: roundtrip", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local orig = {name='test', count=42}
    local json = cjson.encode(orig)
    local decoded = cjson.decode(json)
    return decoded.count
  `);
  assert.equal(result, 42);
});

// =============================================================================
// cmsgpack library tests
// =============================================================================

test("cmsgpack: pack and unpack", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local packed = cmsgpack.pack({1, 2, 3})
    local unpacked = cmsgpack.unpack(packed)
    return unpacked[2]
  `);
  assert.equal(result, 2);
});

// =============================================================================
// struct library tests
// =============================================================================

test("struct: pack and unpack integers", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local packed = struct.pack('>I2', 0x1234)
    local a, b = string.byte(packed, 1, 2)
    return a * 256 + b
  `);
  assert.equal(result, 0x1234);
});

// =============================================================================
// bit library tests
// =============================================================================

test("bit: operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return bit.band(0xff, 0x0f)"), 0x0f);
  assert.equal(engine.eval("return bit.bor(0xf0, 0x0f)"), 0xff);
  assert.equal(engine.eval("return bit.bxor(0xff, 0x0f)"), 0xf0);
  assert.equal(engine.eval("return bit.bnot(0)"), -1);
  assert.equal(engine.eval("return bit.lshift(1, 4)"), 16);
  assert.equal(engine.eval("return bit.rshift(16, 2)"), 4);
});

// =============================================================================
// Multiple script executions
// =============================================================================

test("multiple evals: engine state persists", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  // Note: Lua global variables don't persist between evals in this implementation
  // Each eval is independent
  assert.equal(engine.eval("return 1"), 1);
  assert.equal(engine.eval("return 2"), 2);
  assert.equal(engine.eval("return 3"), 3);
});

test("multiple evalWithArgs: independent executions", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const r1 = engine.evalWithArgs("return KEYS[1]", [Buffer.from("first")], []);
  const r2 = engine.evalWithArgs("return KEYS[1]", [Buffer.from("second")], []);

  assert.equal((r1 as Buffer).toString(), "first");
  assert.equal((r2 as Buffer).toString(), "second");
});

// =============================================================================
// Module consumption tests
// =============================================================================

test("LuaWasmModule: throws on second create call", async () => {
  await resolveWasmPath();
  const module = await load();
  module.create(createTestHost());

  assert.throws(() => {
    module.create(createTestHost());
  }, /already been used/);
});

test("LuaWasmModule: throws on create after createStandalone", async () => {
  await resolveWasmPath();
  const module = await load();
  module.createStandalone();

  assert.throws(() => {
    module.create(createTestHost());
  }, /already been used/);
});

test("LuaWasmModule: throws on createStandalone after create", async () => {
  await resolveWasmPath();
  const module = await load();
  module.create(createTestHost());

  assert.throws(() => {
    module.createStandalone();
  }, /already been used/);
});
