/**
 * @fileoverview Binary codec for the Redis Lua WASM ABI.
 *
 * This module handles serialization and deserialization of data between the
 * JavaScript host and the WASM Lua runtime. All data is binary-safe - null bytes
 * and arbitrary binary content are fully supported.
 *
 * ## Wire Format
 *
 * ### Reply Format
 * Each reply is encoded as:
 * ```
 * [type: u8][count_or_len: u32le][payload: bytes...]
 * ```
 *
 * Type tags:
 * - 0x00: NULL - no payload
 * - 0x01: INTEGER - 8-byte int64le payload
 * - 0x02: BULK STRING - raw bytes payload
 * - 0x03: ARRAY - count of nested Reply items
 * - 0x04: STATUS - raw bytes payload (Redis +OK style)
 * - 0x05: ERROR - raw bytes payload (Redis -ERR style)
 *
 * ### Argument Array Format
 * ```
 * [count: u32le][entry1][entry2]...
 * ```
 * Each entry:
 * ```
 * [len: u32le][bytes...]
 * ```
 *
 * @module codec
 */

import type { ReplyValue } from "./types.js";

/** Reply type tag: null/nil value. Wire format: [0x00][0x00000000] */
const REPLY_NULL = 0x00;

/** Reply type tag: 64-bit signed integer. Wire format: [0x01][0x00000008][int64le] */
const REPLY_INT = 0x01;

/** Reply type tag: bulk string (binary-safe bytes). Wire format: [0x02][length: u32le][bytes...] */
const REPLY_BULK = 0x02;

/** Reply type tag: array of nested replies. Wire format: [0x03][count: u32le][reply1][reply2]... */
const REPLY_ARRAY = 0x03;

/** Reply type tag: status reply (Redis +OK style). Wire format: [0x04][length: u32le][bytes...] */
const REPLY_STATUS = 0x04;

/** Reply type tag: error reply (Redis -ERR style). Wire format: [0x05][length: u32le][bytes...] */
const REPLY_ERROR = 0x05;

/**
 * Converts various input types to a Buffer for binary-safe processing.
 *
 * This function is the foundation of binary safety in the codec - it ensures
 * all data is handled as raw bytes without any string coercion or encoding
 * transformation (except for strings, which are UTF-8 encoded).
 *
 * @param value - The value to convert (Buffer, Uint8Array, or string)
 * @param label - Descriptive label for error messages
 * @returns A Buffer containing the binary data
 * @throws TypeError if value is not a supported type
 *
 * @example
 * ```typescript
 * ensureBuffer(Buffer.from([0x00, 0x01]), "key");  // Returns same Buffer
 * ensureBuffer(new Uint8Array([1, 2]), "key");    // Converts to Buffer
 * ensureBuffer("hello", "key");                    // UTF-8 encodes to Buffer
 * ```
 */
export function ensureBuffer(value: unknown, label: string): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }
  throw new TypeError(`${label} must be a Buffer, Uint8Array, or string`);
}

/**
 * Writes a number or bigint as a little-endian 64-bit signed integer.
 *
 * @param value - The integer value to encode
 * @returns 8-byte Buffer containing the int64le representation
 */
function writeInt64LE(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  const big = typeof value === "bigint" ? value : BigInt(value);
  buf.writeBigInt64LE(big, 0);
  return buf;
}

/**
 * Encodes a ReplyValue into the ABI wire format for transmission to WASM.
 *
 * This is the primary serialization function for sending Redis-compatible
 * reply values to the Lua runtime. The encoding is recursive for arrays
 * and handles all Redis reply types.
 *
 * @param value - The value to encode
 * @returns Buffer containing the encoded wire format
 *
 * @example
 * ```typescript
 * encodeReplyValue(null);                          // NULL reply
 * encodeReplyValue(42);                            // INTEGER reply
 * encodeReplyValue(Buffer.from("hello"));          // BULK STRING reply
 * encodeReplyValue({ ok: Buffer.from("OK") });     // STATUS reply
 * encodeReplyValue({ err: Buffer.from("ERR") });   // ERROR reply
 * encodeReplyValue([1, 2, 3]);                     // ARRAY reply
 * ```
 */
export function encodeReplyValue(value: ReplyValue): Buffer {
  // Handle null/undefined -> NULL reply
  if (value === null || value === undefined) {
    return Buffer.from([REPLY_NULL, 0, 0, 0, 0]);
  }

  // Handle numbers and bigints -> INTEGER reply
  if (typeof value === "number" || typeof value === "bigint") {
    const payload = writeInt64LE(value);
    const header = Buffer.alloc(5);
    header[0] = REPLY_INT;
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }

  // Handle arrays -> ARRAY reply (recursive encoding)
  if (Array.isArray(value)) {
    const items = value.map(encodeReplyValue);
    const header = Buffer.alloc(5);
    header[0] = REPLY_ARRAY;
    header.writeUInt32LE(items.length, 1);
    return Buffer.concat([header, ...items]);
  }

  // Handle objects with 'ok' or 'err' properties -> STATUS/ERROR reply
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "ok")) {
      const payload = ensureBuffer((value as { ok: Buffer }).ok, "status reply");
      const header = Buffer.alloc(5);
      header[0] = REPLY_STATUS;
      header.writeUInt32LE(payload.length, 1);
      return Buffer.concat([header, payload]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "err")) {
      const payload = ensureBuffer((value as { err: Buffer }).err, "error reply");
      const header = Buffer.alloc(5);
      header[0] = REPLY_ERROR;
      header.writeUInt32LE(payload.length, 1);
      return Buffer.concat([header, payload]);
    }
  }

  // Default: treat as bulk string
  const payload = ensureBuffer(value, "bulk reply");
  const header = Buffer.alloc(5);
  header[0] = REPLY_BULK;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/**
 * Decodes the ABI wire format into a ReplyValue tree.
 *
 * This is the primary deserialization function for receiving reply values
 * from the Lua runtime. It recursively decodes nested arrays and returns
 * both the decoded value and the new buffer offset.
 *
 * @param buffer - The buffer containing encoded reply data
 * @param offset - Starting offset in the buffer (default: 0)
 * @returns Object containing the decoded value and new offset position
 * @throws Error if the buffer is truncated or contains unknown types
 *
 * @example
 * ```typescript
 * const { value, offset } = decodeReply(buffer);
 * // value is the decoded ReplyValue
 * // offset is the position after the decoded data
 * ```
 */
export function decodeReply(buffer: Buffer, offset = 0): { value: ReplyValue; offset: number } {
  // Validate minimum header size (1 byte type + 4 bytes count/len)
  if (offset + 5 > buffer.length) {
    throw new Error("ERR reply decoding failed");
  }

  const type = buffer.readUInt8(offset);
  const countOrLen = buffer.readUInt32LE(offset + 1);
  let cursor = offset + 5;

  // Decode based on type tag
  if (type === REPLY_NULL) {
    return { value: null, offset: cursor };
  }

  if (type === REPLY_INT) {
    if (cursor + 8 > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const big = buffer.readBigInt64LE(cursor);
    cursor += 8;
    // Return number if within safe integer range, otherwise bigint
    const value =
      big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER)
        ? Number(big)
        : big;
    return { value, offset: cursor };
  }

  if (type === REPLY_BULK) {
    const payload = buffer.subarray(cursor, cursor + countOrLen);
    cursor += countOrLen;
    return { value: Buffer.from(payload), offset: cursor };
  }

  if (type === REPLY_STATUS) {
    const payload = buffer.subarray(cursor, cursor + countOrLen);
    cursor += countOrLen;
    return { value: { ok: Buffer.from(payload) }, offset: cursor };
  }

  if (type === REPLY_ERROR) {
    const payload = buffer.subarray(cursor, cursor + countOrLen);
    cursor += countOrLen;
    return { value: { err: Buffer.from(payload) }, offset: cursor };
  }

  if (type === REPLY_ARRAY) {
    const items: ReplyValue[] = [];
    for (let i = 0; i < countOrLen; i += 1) {
      const decoded = decodeReply(buffer, cursor);
      items.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value: items, offset: cursor };
  }

  throw new Error("ERR unknown reply type");
}

/**
 * Encodes an array of arguments into the ArgArray ABI format.
 *
 * This format is used for passing KEYS and ARGV to Lua scripts, as well as
 * for encoding redis.call/redis.pcall arguments. All arguments are converted
 * to binary-safe buffers.
 *
 * Wire format:
 * ```
 * [count: u32le][len1: u32le][bytes1...][len2: u32le][bytes2...]...
 * ```
 *
 * @param args - Array of arguments (Buffer, Uint8Array, or string)
 * @returns Buffer containing the encoded argument array
 *
 * @example
 * ```typescript
 * encodeArgArray([Buffer.from("GET"), Buffer.from("key:1")]);
 * encodeArgArray(["SET", "key", "value"]);  // Strings are UTF-8 encoded
 * ```
 */
export function encodeArgArray(args: Array<Buffer | Uint8Array | string>): Buffer {
  const parts: Buffer[] = [];

  // Write argument count
  const header = Buffer.alloc(4);
  header.writeUInt32LE(args.length, 0);
  parts.push(header);

  // Write each argument as [length][bytes]
  for (const arg of args) {
    const buf = ensureBuffer(arg, "arg");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    parts.push(len, buf);
  }

  return Buffer.concat(parts);
}

/**
 * Packs a pointer and length into a single bigint for non-sret ABI paths.
 *
 * Some WASM ABI calling conventions return pointer+length pairs as a single
 * 64-bit value. This function creates such a packed value with the pointer
 * in the lower 32 bits and length in the upper 32 bits.
 *
 * @param ptr - Memory pointer (32-bit unsigned)
 * @param len - Data length (32-bit unsigned)
 * @returns Packed bigint: (len << 32) | ptr
 *
 * @example
 * ```typescript
 * const packed = packPtrLen(0x1000, 256);
 * // packed = 0x0000010000001000n
 * ```
 */
export function packPtrLen(ptr: number, len: number): bigint {
  return (BigInt(len) << 32n) | BigInt(ptr >>> 0);
}

/**
 * Unpacks a PtrLen from various ABI return shapes.
 *
 * Different WASM runtimes and calling conventions may return pointer+length
 * pairs in different formats. This function handles:
 * - bigint: packed format from packPtrLen
 * - number[]: array of [ptr, len]
 * - { ptr, len }: explicit object format
 *
 * @param result - The return value from a WASM function
 * @returns Object containing ptr and len as numbers
 * @throws Error if the input format is not recognized
 *
 * @example
 * ```typescript
 * unpackPtrLen(0x0000010000001000n);      // { ptr: 0x1000, len: 256 }
 * unpackPtrLen([0x1000, 256]);            // { ptr: 0x1000, len: 256 }
 * unpackPtrLen({ ptr: 0x1000, len: 256 }); // { ptr: 0x1000, len: 256 }
 * ```
 */
export function unpackPtrLen(result: bigint | number[] | { ptr: number; len: number }): {
  ptr: number;
  len: number;
} {
  if (typeof result === "bigint") {
    const ptr = Number(result & 0xffffffffn);
    const len = Number(result >> 32n);
    return { ptr, len };
  }
  if (Array.isArray(result)) {
    return { ptr: Number(result[0]), len: Number(result[1]) };
  }
  if (result && typeof result === "object" && "ptr" in result && "len" in result) {
    return { ptr: Number(result.ptr), len: Number(result.len) };
  }
  throw new Error("Unexpected PtrLen return type");
}
