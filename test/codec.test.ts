/**
 * Unit tests for codec.ts - Binary encoding/decoding for the Redis Lua WASM ABI.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureBuffer,
  encodeReplyValue,
  decodeReply,
  encodeArgArray,
  packPtrLen,
  unpackPtrLen
} from "../src/codec.js";

// -----------------------------------------------------------------------------
// ensureBuffer tests
// -----------------------------------------------------------------------------

test("ensureBuffer: accepts Buffer", () => {
  const buf = Buffer.from([1, 2, 3]);
  const result = ensureBuffer(buf, "test");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual(result, buf);
});

test("ensureBuffer: accepts Uint8Array", () => {
  const arr = new Uint8Array([4, 5, 6]);
  const result = ensureBuffer(arr, "test");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...result], [4, 5, 6]);
});

test("ensureBuffer: accepts string", () => {
  const result = ensureBuffer("hello", "test");
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString("utf8"), "hello");
});

test("ensureBuffer: accepts string with unicode", () => {
  const result = ensureBuffer("héllo 世界", "test");
  assert.ok(Buffer.isBuffer(result));
  assert.equal(result.toString("utf8"), "héllo 世界");
});

test("ensureBuffer: throws on number", () => {
  assert.throws(
    () => ensureBuffer(123, "test"),
    { message: "test must be a Buffer, Uint8Array, or string" }
  );
});

test("ensureBuffer: throws on object", () => {
  assert.throws(
    () => ensureBuffer({ foo: "bar" }, "test"),
    { message: "test must be a Buffer, Uint8Array, or string" }
  );
});

test("ensureBuffer: throws on null", () => {
  assert.throws(
    () => ensureBuffer(null, "test"),
    { message: "test must be a Buffer, Uint8Array, or string" }
  );
});

// -----------------------------------------------------------------------------
// encodeReplyValue tests
// -----------------------------------------------------------------------------

test("encodeReplyValue: null", () => {
  const encoded = encodeReplyValue(null);
  assert.equal(encoded[0], 0x00); // REPLY_NULL
  assert.equal(encoded.length, 5);
});

test("encodeReplyValue: undefined treated as null", () => {
  const encoded = encodeReplyValue(undefined as unknown as null);
  assert.equal(encoded[0], 0x00); // REPLY_NULL
});

test("encodeReplyValue: positive integer", () => {
  const encoded = encodeReplyValue(42);
  assert.equal(encoded[0], 0x01); // REPLY_INT
  assert.equal(encoded.readUInt32LE(1), 8); // int64 length
  assert.equal(encoded.readBigInt64LE(5), 42n);
});

test("encodeReplyValue: negative integer", () => {
  const encoded = encodeReplyValue(-100);
  assert.equal(encoded[0], 0x01); // REPLY_INT
  assert.equal(encoded.readBigInt64LE(5), -100n);
});

test("encodeReplyValue: bigint", () => {
  const big = BigInt("9223372036854775807"); // Max int64
  const encoded = encodeReplyValue(big);
  assert.equal(encoded[0], 0x01); // REPLY_INT
  assert.equal(encoded.readBigInt64LE(5), big);
});

test("encodeReplyValue: bigint negative", () => {
  const big = BigInt("-9223372036854775808"); // Min int64
  const encoded = encodeReplyValue(big);
  assert.equal(encoded[0], 0x01); // REPLY_INT
  assert.equal(encoded.readBigInt64LE(5), big);
});

test("encodeReplyValue: Buffer (bulk string)", () => {
  const buf = Buffer.from("hello");
  const encoded = encodeReplyValue(buf);
  assert.equal(encoded[0], 0x02); // REPLY_BULK
  assert.equal(encoded.readUInt32LE(1), 5); // length
  assert.equal(encoded.subarray(5).toString("utf8"), "hello");
});

test("encodeReplyValue: Buffer with null bytes", () => {
  const buf = Buffer.from([0x00, 0x01, 0x00, 0x02]);
  const encoded = encodeReplyValue(buf);
  assert.equal(encoded[0], 0x02); // REPLY_BULK
  assert.equal(encoded.readUInt32LE(1), 4);
  assert.deepEqual([...encoded.subarray(5)], [0x00, 0x01, 0x00, 0x02]);
});

test("encodeReplyValue: empty Buffer", () => {
  const buf = Buffer.alloc(0);
  const encoded = encodeReplyValue(buf);
  assert.equal(encoded[0], 0x02); // REPLY_BULK
  assert.equal(encoded.readUInt32LE(1), 0);
  assert.equal(encoded.length, 5);
});

test("encodeReplyValue: status reply (ok)", () => {
  const encoded = encodeReplyValue({ ok: Buffer.from("PONG") });
  assert.equal(encoded[0], 0x04); // REPLY_STATUS
  assert.equal(encoded.readUInt32LE(1), 4);
  assert.equal(encoded.subarray(5).toString("utf8"), "PONG");
});

test("encodeReplyValue: error reply (err)", () => {
  const encoded = encodeReplyValue({ err: Buffer.from("ERR unknown") });
  assert.equal(encoded[0], 0x05); // REPLY_ERROR
  assert.equal(encoded.readUInt32LE(1), 11);
  assert.equal(encoded.subarray(5).toString("utf8"), "ERR unknown");
});

test("encodeReplyValue: empty array", () => {
  const encoded = encodeReplyValue([]);
  assert.equal(encoded[0], 0x03); // REPLY_ARRAY
  assert.equal(encoded.readUInt32LE(1), 0); // count
  assert.equal(encoded.length, 5);
});

test("encodeReplyValue: array with integers", () => {
  const encoded = encodeReplyValue([1, 2, 3]);
  assert.equal(encoded[0], 0x03); // REPLY_ARRAY
  assert.equal(encoded.readUInt32LE(1), 3); // count
});

test("encodeReplyValue: nested array", () => {
  const encoded = encodeReplyValue([[1, 2], [3, 4]]);
  assert.equal(encoded[0], 0x03); // REPLY_ARRAY
  assert.equal(encoded.readUInt32LE(1), 2); // outer count
});

test("encodeReplyValue: mixed array", () => {
  const value = [
    1,
    Buffer.from("hello"),
    null,
    { ok: Buffer.from("OK") },
    [1, 2]
  ];
  const encoded = encodeReplyValue(value);
  assert.equal(encoded[0], 0x03); // REPLY_ARRAY
  assert.equal(encoded.readUInt32LE(1), 5); // count
});

// -----------------------------------------------------------------------------
// decodeReply tests
// -----------------------------------------------------------------------------

test("decodeReply: null", () => {
  const buf = Buffer.from([0x00, 0, 0, 0, 0]);
  const { value, offset } = decodeReply(buf);
  assert.equal(value, null);
  assert.equal(offset, 5);
});

test("decodeReply: positive integer", () => {
  const buf = Buffer.alloc(13);
  buf[0] = 0x01; // REPLY_INT
  buf.writeUInt32LE(8, 1);
  buf.writeBigInt64LE(42n, 5);
  const { value, offset } = decodeReply(buf);
  assert.equal(value, 42);
  assert.equal(offset, 13);
});

test("decodeReply: large integer returns bigint", () => {
  const buf = Buffer.alloc(13);
  buf[0] = 0x01; // REPLY_INT
  buf.writeUInt32LE(8, 1);
  buf.writeBigInt64LE(BigInt("9223372036854775807"), 5);
  const { value } = decodeReply(buf);
  assert.equal(typeof value, "bigint");
  assert.equal(value, BigInt("9223372036854775807"));
});

test("decodeReply: small negative integer returns number", () => {
  const buf = Buffer.alloc(13);
  buf[0] = 0x01;
  buf.writeUInt32LE(8, 1);
  buf.writeBigInt64LE(-100n, 5);
  const { value } = decodeReply(buf);
  assert.equal(typeof value, "number");
  assert.equal(value, -100);
});

test("decodeReply: bulk string", () => {
  const content = Buffer.from("hello");
  const buf = Buffer.alloc(5 + content.length);
  buf[0] = 0x02; // REPLY_BULK
  buf.writeUInt32LE(content.length, 1);
  content.copy(buf, 5);
  const { value } = decodeReply(buf);
  assert.ok(Buffer.isBuffer(value));
  assert.equal((value as Buffer).toString("utf8"), "hello");
});

test("decodeReply: bulk string with null bytes", () => {
  const content = Buffer.from([0x00, 0x01, 0x00]);
  const buf = Buffer.alloc(5 + content.length);
  buf[0] = 0x02;
  buf.writeUInt32LE(content.length, 1);
  content.copy(buf, 5);
  const { value } = decodeReply(buf);
  assert.ok(Buffer.isBuffer(value));
  assert.deepEqual([...(value as Buffer)], [0x00, 0x01, 0x00]);
});

test("decodeReply: status reply", () => {
  const content = Buffer.from("OK");
  const buf = Buffer.alloc(5 + content.length);
  buf[0] = 0x04; // REPLY_STATUS
  buf.writeUInt32LE(content.length, 1);
  content.copy(buf, 5);
  const { value } = decodeReply(buf);
  assert.ok(value && typeof value === "object" && "ok" in value);
  assert.equal((value as { ok: Buffer }).ok.toString("utf8"), "OK");
});

test("decodeReply: error reply", () => {
  const content = Buffer.from("ERR boom");
  const buf = Buffer.alloc(5 + content.length);
  buf[0] = 0x05; // REPLY_ERROR
  buf.writeUInt32LE(content.length, 1);
  content.copy(buf, 5);
  const { value } = decodeReply(buf);
  assert.ok(value && typeof value === "object" && "err" in value);
  assert.equal((value as { err: Buffer }).err.toString("utf8"), "ERR boom");
});

test("decodeReply: empty array", () => {
  const buf = Buffer.from([0x03, 0, 0, 0, 0]);
  const { value } = decodeReply(buf);
  assert.ok(Array.isArray(value));
  assert.equal((value as unknown[]).length, 0);
});

test("decodeReply: array with integers", () => {
  // Encode [1, 2, 3] manually
  const items = [1, 2, 3].map((n) => {
    const item = Buffer.alloc(13);
    item[0] = 0x01;
    item.writeUInt32LE(8, 1);
    item.writeBigInt64LE(BigInt(n), 5);
    return item;
  });
  const header = Buffer.alloc(5);
  header[0] = 0x03;
  header.writeUInt32LE(3, 1);
  const buf = Buffer.concat([header, ...items]);
  const { value } = decodeReply(buf);
  assert.ok(Array.isArray(value));
  assert.deepEqual(value, [1, 2, 3]);
});

test("decodeReply: throws on truncated buffer", () => {
  const buf = Buffer.from([0x01]); // Too short
  assert.throws(() => decodeReply(buf), { message: "ERR reply decoding failed" });
});

test("decodeReply: throws on unknown type", () => {
  const buf = Buffer.from([0xff, 0, 0, 0, 0]);
  assert.throws(() => decodeReply(buf), { message: "ERR unknown reply type" });
});

test("decodeReply: roundtrip - complex value", () => {
  const original = [
    1,
    Buffer.from("test"),
    null,
    { ok: Buffer.from("OK") },
    { err: Buffer.from("ERR") },
    [10, 20, 30]
  ];
  const encoded = encodeReplyValue(original);
  const { value } = decodeReply(encoded);

  assert.ok(Array.isArray(value));
  const arr = value as unknown[];
  assert.equal(arr[0], 1);
  assert.ok(Buffer.isBuffer(arr[1]));
  assert.equal((arr[1] as Buffer).toString(), "test");
  assert.equal(arr[2], null);
  assert.deepEqual((arr[3] as { ok: Buffer }).ok.toString(), "OK");
  assert.deepEqual((arr[4] as { err: Buffer }).err.toString(), "ERR");
  assert.deepEqual(arr[5], [10, 20, 30]);
});

// -----------------------------------------------------------------------------
// encodeArgArray tests
// -----------------------------------------------------------------------------

test("encodeArgArray: empty array", () => {
  const encoded = encodeArgArray([]);
  assert.equal(encoded.readUInt32LE(0), 0); // count
  assert.equal(encoded.length, 4);
});

test("encodeArgArray: single Buffer", () => {
  const encoded = encodeArgArray([Buffer.from("hello")]);
  assert.equal(encoded.readUInt32LE(0), 1); // count
  assert.equal(encoded.readUInt32LE(4), 5); // length of "hello"
  assert.equal(encoded.subarray(8).toString("utf8"), "hello");
});

test("encodeArgArray: multiple Buffers", () => {
  const encoded = encodeArgArray([
    Buffer.from("GET"),
    Buffer.from("key:1"),
  ]);
  assert.equal(encoded.readUInt32LE(0), 2); // count
});

test("encodeArgArray: accepts strings", () => {
  const encoded = encodeArgArray(["GET", "key"]);
  assert.equal(encoded.readUInt32LE(0), 2);
});

test("encodeArgArray: accepts Uint8Array", () => {
  const encoded = encodeArgArray([new Uint8Array([1, 2, 3])]);
  assert.equal(encoded.readUInt32LE(0), 1);
  assert.equal(encoded.readUInt32LE(4), 3);
});

test("encodeArgArray: binary-safe with null bytes", () => {
  const arg = Buffer.from([0x00, 0x01, 0x00]);
  const encoded = encodeArgArray([arg]);
  assert.equal(encoded.readUInt32LE(0), 1);
  assert.equal(encoded.readUInt32LE(4), 3);
  assert.deepEqual([...encoded.subarray(8)], [0x00, 0x01, 0x00]);
});

// -----------------------------------------------------------------------------
// packPtrLen / unpackPtrLen tests
// -----------------------------------------------------------------------------

test("packPtrLen: packs ptr and len into bigint", () => {
  const packed = packPtrLen(0x12345678, 0x9abcdef0);
  // len in upper 32 bits, ptr in lower 32 bits
  assert.equal(packed & 0xffffffffn, 0x12345678n);
  assert.equal(packed >> 32n, 0x9abcdef0n);
});

test("packPtrLen: handles zero values", () => {
  const packed = packPtrLen(0, 0);
  assert.equal(packed, 0n);
});

test("unpackPtrLen: unpacks bigint", () => {
  const packed = packPtrLen(100, 200);
  const { ptr, len } = unpackPtrLen(packed);
  assert.equal(ptr, 100);
  assert.equal(len, 200);
});

test("unpackPtrLen: unpacks array", () => {
  const { ptr, len } = unpackPtrLen([1000, 2000]);
  assert.equal(ptr, 1000);
  assert.equal(len, 2000);
});

test("unpackPtrLen: unpacks object", () => {
  const { ptr, len } = unpackPtrLen({ ptr: 500, len: 600 });
  assert.equal(ptr, 500);
  assert.equal(len, 600);
});

test("unpackPtrLen: throws on invalid input", () => {
  assert.throws(
    () => unpackPtrLen("invalid" as unknown as bigint),
    { message: "Unexpected PtrLen return type" }
  );
});

test("unpackPtrLen: roundtrip", () => {
  const originalPtr = 0xaabbccdd;
  const originalLen = 0x11223344;
  const packed = packPtrLen(originalPtr, originalLen);
  const { ptr, len } = unpackPtrLen(packed);
  assert.equal(ptr, originalPtr);
  assert.equal(len, originalLen);
});
