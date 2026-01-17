/**
 * Conformance tests for Redis Lua modules and standard libraries.
 *
 * These tests verify that the WASM Lua runtime correctly implements:
 * - Basic Lua evaluation
 * - Binary-safe string handling
 * - cjson module (JSON encoding/decoding)
 * - cmsgpack module (MessagePack serialization)
 * - struct module (binary packing)
 * - bit module (bitwise operations)
 * - Standard Lua libraries (string, math, table)
 * - redis.sha1hex function
 */
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.js";

// Helper to resolve WASM path
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

// Create a minimal host for conformance tests (no redis.call support needed)
function createConformanceHost() {
  return {
    redisCall() {
      return { err: Buffer.from("ERR redis.call not available in conformance tests") };
    },
    redisPcall() {
      return { err: Buffer.from("ERR redis.pcall not available in conformance tests") };
    },
    log() {}
  };
}

// =============================================================================
// Basic Lua Evaluation
// =============================================================================

test("conformance: basic_eval - arithmetic", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval("return 1 + 1");
  assert.equal(result, 2);
});

test("conformance: binary_return - null bytes in string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  // Lua: return "a\0b" -> binary string with null byte
  const result = engine.eval('return "a\\0b"');
  assert.ok(Buffer.isBuffer(result));
  // "a\0b" = [0x61, 0x00, 0x62] = base64 "YQBi"
  assert.deepEqual([...(result as Buffer)], [0x61, 0x00, 0x62]);
});

// =============================================================================
// cjson Module
// =============================================================================

test("conformance: cjson_basic - encode object", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval("return cjson.encode({ a = 1 })");
  assert.ok(Buffer.isBuffer(result));
  // {"a":1} = base64 "eyJhIjoxfQ=="
  assert.equal((result as Buffer).toString(), '{"a":1}');
});

test("conformance: cjson_advanced - roundtrip with nested structures", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local orig = {
      name = "test",
      count = 42,
      nested = { a = 1, b = 2 },
      array = { 1, 2, 3 }
    }

    local json = cjson.encode(orig)
    local decoded = cjson.decode(json)

    if decoded.name ~= "test" then return 0 end
    if decoded.count ~= 42 then return 0 end
    if decoded.nested.a ~= 1 then return 0 end
    if decoded.nested.b ~= 2 then return 0 end

    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

// =============================================================================
// cmsgpack Module
// =============================================================================

test("conformance: cmsgpack_basic - pack array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval("return cmsgpack.pack({ 1, 2, 3 })");
  assert.ok(Buffer.isBuffer(result));
  // msgpack [1,2,3] = [0x93, 0x01, 0x02, 0x03] = base64 "kwECAw=="
  assert.deepEqual([...(result as Buffer)], [0x93, 0x01, 0x02, 0x03]);
});

test("conformance: cmsgpack_advanced - roundtrip with various types", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local orig = {
      int_val = 12345,
      str_val = "hello",
      array_val = {1, 2, 3},
      nested = { x = 10 }
    }

    local packed = cmsgpack.pack(orig)
    local unpacked = cmsgpack.unpack(packed)

    if unpacked.int_val ~= 12345 then return 0 end
    if unpacked.str_val ~= "hello" then return 0 end
    if unpacked.array_val[2] ~= 2 then return 0 end
    if unpacked.nested.x ~= 10 then return 0 end

    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

// =============================================================================
// struct Module
// =============================================================================

test("conformance: struct_basic - pack big-endian uint16", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval('return struct.pack(">I2", 0x1234)');
  assert.ok(Buffer.isBuffer(result));
  // big-endian 0x1234 = [0x12, 0x34] = base64 "EjQ="
  assert.deepEqual([...(result as Buffer)], [0x12, 0x34]);
});

test("conformance: struct - pack and unpack", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local packed = struct.pack('>I2', 0x1234)
    local a, b = string.byte(packed, 1, 2)
    return a * 256 + b
  `;

  const result = engine.eval(script);
  assert.equal(result, 0x1234);
});

// =============================================================================
// bit Module
// =============================================================================

test("conformance: bit_basic - xor and tohex", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval("return bit.tohex(bit.bxor(0x0f, 0xf0))");
  assert.ok(Buffer.isBuffer(result));
  // 0x0f XOR 0xf0 = 0xff, tohex = "ff" = base64 "ZmY="
  assert.equal((result as Buffer).toString(), "000000ff");
});

test("conformance: bit_advanced - comprehensive bitwise operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local results = {}

    -- Bitwise AND
    table.insert(results, bit.band(0xff, 0x0f) == 0x0f)
    table.insert(results, bit.band(0x12, 0x10) == 0x10)

    -- Bitwise OR
    table.insert(results, bit.bor(0xf0, 0x0f) == 0xff)

    -- Bitwise XOR
    table.insert(results, bit.bxor(0xff, 0x0f) == 0xf0)

    -- Bitwise NOT
    table.insert(results, bit.bnot(0) == -1)

    -- Left shift
    table.insert(results, bit.lshift(1, 4) == 16)
    table.insert(results, bit.lshift(1, 8) == 256)

    -- Right shift
    table.insert(results, bit.rshift(256, 4) == 16)

    -- Arithmetic right shift
    table.insert(results, bit.arshift(256, 4) == 16)

    -- Rotate
    table.insert(results, bit.rol(0x12345678, 4) == 0x23456781)

    for _, v in ipairs(results) do
      if not v then return 0 end
    end
    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

// =============================================================================
// Standard Lua Libraries
// =============================================================================

test("conformance: string_lib - string operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local results = {}

    table.insert(results, string.len("hello") == 5)
    table.insert(results, string.upper("test") == "TEST")
    table.insert(results, string.lower("TEST") == "test")
    table.insert(results, string.sub("hello", 2, 4) == "ell")
    table.insert(results, string.rep("ab", 3) == "ababab")
    table.insert(results, string.reverse("abc") == "cba")

    for _, v in ipairs(results) do
      if not v then return 0 end
    end
    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

test("conformance: math_lib - math operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local results = {}

    table.insert(results, math.abs(-5) == 5)
    table.insert(results, math.max(1, 5, 3) == 5)
    table.insert(results, math.min(1, 5, 3) == 1)
    table.insert(results, math.floor(3.7) == 3)
    table.insert(results, math.ceil(3.2) == 4)
    table.insert(results, math.sqrt(16) == 4)
    table.insert(results, math.pow(2, 3) == 8)

    for _, v in ipairs(results) do
      if not v then return 0 end
    end
    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

test("conformance: table_lib - table operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local results = {}

    -- table.concat
    table.insert(results, table.concat({"a", "b", "c"}, ",") == "a,b,c")
    table.insert(results, table.concat({1, 2, 3}, "-") == "1-2-3")

    -- table.insert / remove
    local t = {1, 2, 3}
    table.insert(t, 4)
    table.insert(results, t[4] == 4)

    table.remove(t, 1)
    table.insert(results, t[1] == 2)

    -- table.sort
    local s = {3, 1, 2}
    table.sort(s)
    table.insert(results, s[1] == 1 and s[2] == 2 and s[3] == 3)

    for _, v in ipairs(results) do
      if not v then return 0 end
    end
    return 1
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

// =============================================================================
// redis.sha1hex
// =============================================================================

test("conformance: sha1hex - compute SHA1 hash", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local hash = redis.sha1hex("hello")
    if hash == "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d" then
      return 1
    end
    return 0
  `;

  const result = engine.eval(script);
  assert.equal(result, 1);
});

test("conformance: sha1hex - empty string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval('return redis.sha1hex("")');
  assert.ok(Buffer.isBuffer(result));
  // SHA1 of empty string
  assert.equal((result as Buffer).toString(), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

// =============================================================================
// Additional edge cases
// =============================================================================

test("conformance: cjson - decode and access", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const result = engine.eval('local t = cjson.decode(\'{"x":10}\'); return t.x');
  assert.equal(result, 10);
});

test("conformance: cmsgpack - nested roundtrip", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  const script = `
    local packed = cmsgpack.pack({1, 2, 3})
    local unpacked = cmsgpack.unpack(packed)
    return unpacked[2]
  `;

  const result = engine.eval(script);
  assert.equal(result, 2);
});

test("conformance: bit - tobit and tohex", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createConformanceHost());

  assert.equal(engine.eval("return bit.band(0xff, 0x0f)"), 0x0f);
  assert.equal(engine.eval("return bit.bor(0xf0, 0x0f)"), 0xff);
  assert.equal(engine.eval("return bit.bxor(0xff, 0x0f)"), 0xf0);
  assert.equal(engine.eval("return bit.lshift(1, 4)"), 16);
  assert.equal(engine.eval("return bit.rshift(16, 2)"), 4);
});
