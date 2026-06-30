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
 * - 0x07: BOOL - 1-byte boolean payload
 * - 0x08: DOUBLE - 8-byte f64le payload
 * - 0x09: MAP - count of key/value pairs
 * - 0x0a: SET - count of nested Reply items
 * - 0x0b: BIG NUMBER - raw bytes payload
 * - 0x0c: VERBATIM STRING - [format_len: u32le][format][string]
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

import type { ReplyValue, RedisProps } from "./types.js";

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
 * Reply type tag: script-aborting error. Same wire payload as REPLY_ERROR, but
 * signals that the error aborted the script (uncaught runtime error or an error
 * that propagated out of redis.call) and should be decorated with the script
 * sha / source context by the engine. Returned error *values* (e.g.
 * `return redis.pcall(...)`) use REPLY_ERROR and are left undecorated.
 * Wire format: [0x06][length: u32le][bytes...]
 */
export const REPLY_SCRIPT_ERROR = 0x06;

const REPLY_BOOL = 0x07;
const REPLY_DOUBLE = 0x08;
const REPLY_MAP = 0x09;
const REPLY_SET = 0x0a;
const REPLY_BIG_NUMBER = 0x0b;
const REPLY_VERBATIM = 0x0c;

/** redisProps wire kinds. */
const PROP_KIND_FIELD = 0;
const PROP_KIND_STUB = 1;

/** redisProps wire value types. */
const PROP_VTYPE_NONE = 0;
const PROP_VTYPE_BOOL = 1;
const PROP_VTYPE_NUMBER = 2;
const PROP_VTYPE_STRING = 3;

/**
 * Splits a raw error payload (`CODE message`) into a structured error reply.
 *
 * The leading token is treated as the error code only when it matches
 * `/^[A-Z][A-Z0-9]*$/` (Redis error-code convention); otherwise the whole
 * payload is the message and `code` is omitted. Binary-safe: the message bytes
 * are preserved verbatim.
 */
function splitErrorPayload(payload: Buffer): { err: Buffer; code?: Buffer } {
  const space = payload.indexOf(0x20);
  if (space > 0 && isErrorCode(payload, space)) {
    return {
      err: Buffer.from(payload.subarray(space + 1)),
      code: Buffer.from(payload.subarray(0, space)),
    };
  }
  return { err: Buffer.from(payload) };
}

/** Tests whether `buffer[0, end)` matches the Redis error-code shape `[A-Z][A-Z0-9]*`. */
function isErrorCode(buffer: Buffer, end: number): boolean {
  if (buffer[0] < 0x41 || buffer[0] > 0x5a) {
    return false;
  }
  for (let i = 1; i < end; i += 1) {
    const c = buffer[i];
    const isUpper = c >= 0x41 && c <= 0x5a;
    const isDigit = c >= 0x30 && c <= 0x39;
    if (!isUpper && !isDigit) {
      return false;
    }
  }
  return true;
}

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

function writeDoubleLE(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return buf;
}

function header(type: number, countOrLen: number): Buffer {
  const out = Buffer.alloc(5);
  out[0] = type;
  out.writeUInt32LE(countOrLen, 1);
  return out;
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

  if (typeof value === "boolean") {
    return Buffer.concat([
      header(REPLY_BOOL, 1),
      Buffer.from([value ? 1 : 0]),
    ]);
  }

  // Handle numbers and bigints -> INTEGER reply
  if (typeof value === "number" || typeof value === "bigint") {
    const payload = writeInt64LE(value);
    return Buffer.concat([header(REPLY_INT, payload.length), payload]);
  }

  // Handle arrays -> ARRAY reply (recursive encoding)
  if (Array.isArray(value)) {
    const items = value.map(encodeReplyValue);
    return Buffer.concat([header(REPLY_ARRAY, items.length), ...items]);
  }

  // Handle objects with 'ok' or 'err' properties -> STATUS/ERROR reply
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "double")) {
      const payload = writeDoubleLE((value as { double: number }).double);
      return Buffer.concat([header(REPLY_DOUBLE, payload.length), payload]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "big_number")) {
      const payload = ensureBuffer(
        (value as { big_number: Buffer }).big_number,
        "big number reply",
      );
      return Buffer.concat([header(REPLY_BIG_NUMBER, payload.length), payload]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "verbatim_string")) {
      const verbatim = (value as {
        verbatim_string: { format: Buffer; string: Buffer };
      }).verbatim_string;
      const format = ensureBuffer(verbatim.format, "verbatim format");
      const string = ensureBuffer(verbatim.string, "verbatim string");
      const formatHeader = Buffer.alloc(4);
      formatHeader.writeUInt32LE(format.length, 0);
      const payload = Buffer.concat([formatHeader, format, string]);
      return Buffer.concat([header(REPLY_VERBATIM, payload.length), payload]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "map")) {
      const pairs = (value as { map: [ReplyValue, ReplyValue][] }).map;
      const encoded = pairs.flatMap(([key, item]) => [
        encodeReplyValue(key),
        encodeReplyValue(item),
      ]);
      return Buffer.concat([header(REPLY_MAP, pairs.length), ...encoded]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "set")) {
      const items = (value as { set: ReplyValue[] }).set.map(encodeReplyValue);
      return Buffer.concat([header(REPLY_SET, items.length), ...items]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "ok")) {
      const payload = ensureBuffer(
        (value as { ok: Buffer }).ok,
        "status reply",
      );
      return Buffer.concat([header(REPLY_STATUS, payload.length), payload]);
    }
    if (Object.prototype.hasOwnProperty.call(value, "err")) {
      const errValue = value as { err: Buffer; code?: Buffer };
      const message = ensureBuffer(errValue.err, "error reply");
      // Prepend the code so the wire payload is the Redis "CODE message" form.
      const payload = errValue.code
        ? Buffer.concat([
            ensureBuffer(errValue.code, "error code"),
            Buffer.from(" "),
            message,
          ])
        : message;
      return Buffer.concat([header(REPLY_ERROR, payload.length), payload]);
    }
  }

  // Default: treat as bulk string
  const payload = ensureBuffer(value, "bulk reply");
  return Buffer.concat([header(REPLY_BULK, payload.length), payload]);
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
export function decodeReply(
  buffer: Buffer,
  offset = 0,
): { value: ReplyValue; offset: number } {
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
      big >= BigInt(Number.MIN_SAFE_INTEGER) &&
      big <= BigInt(Number.MAX_SAFE_INTEGER)
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
    return { value: splitErrorPayload(payload), offset: cursor };
  }

  if (type === REPLY_SCRIPT_ERROR) {
    // Payload is a u32le `line` (0 = unknown, parse from message prefix) followed
    // by the `CODE message` bytes. See reply_script_error in wasm/src/runtime.c.
    const line = buffer.readUInt32LE(cursor);
    const payload = buffer.subarray(cursor + 4, cursor + countOrLen);
    cursor += countOrLen;
    const error = splitErrorPayload(payload);
    // `line` is internal plumbing consumed by buildScriptError; it is not part of
    // the public ReplyValue contract, hence the cast.
    const value = (line > 0 ? { ...error, line } : error) as ReplyValue;
    return { value, offset: cursor };
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

  if (type === REPLY_BOOL) {
    if (cursor + 1 > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    return { value: buffer[cursor] !== 0, offset: cursor + 1 };
  }

  if (type === REPLY_DOUBLE) {
    if (cursor + 8 > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const value = buffer.readDoubleLE(cursor);
    return { value: { double: value }, offset: cursor + 8 };
  }

  if (type === REPLY_BIG_NUMBER) {
    if (cursor + countOrLen > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const payload = buffer.subarray(cursor, cursor + countOrLen);
    cursor += countOrLen;
    return { value: { big_number: Buffer.from(payload) }, offset: cursor };
  }

  if (type === REPLY_VERBATIM) {
    if (cursor + 4 > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const end = cursor + countOrLen;
    const formatLen = buffer.readUInt32LE(cursor);
    cursor += 4;
    if (cursor + formatLen > end || end > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const format = Buffer.from(buffer.subarray(cursor, cursor + formatLen));
    cursor += formatLen;
    const string = Buffer.from(buffer.subarray(cursor, end));
    return { value: { verbatim_string: { format, string } }, offset: end };
  }

  if (type === REPLY_MAP) {
    const map: [ReplyValue, ReplyValue][] = [];
    for (let i = 0; i < countOrLen; i += 1) {
      const key = decodeReply(buffer, cursor);
      cursor = key.offset;
      const item = decodeReply(buffer, cursor);
      cursor = item.offset;
      map.push([key.value, item.value]);
    }
    return { value: { map }, offset: cursor };
  }

  if (type === REPLY_SET) {
    const set: ReplyValue[] = [];
    for (let i = 0; i < countOrLen; i += 1) {
      const decoded = decodeReply(buffer, cursor);
      set.push(decoded.value);
      cursor = decoded.offset;
    }
    return { value: { set }, offset: cursor };
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
export function encodeArgArray(
  args: Array<Buffer | Uint8Array | string>,
): Buffer {
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
 * Encodes host-injected `redis.*` props into the typed blob consumed by the WASM
 * `host_redis_props` import.
 *
 * Wire format (little-endian):
 * ```
 * [count: u32]
 * per entry:
 *   [name_len: u32][name bytes]
 *   [kind: u8]    // 0 = field, 1 = stub function
 *   [vtype: u8]   // 0 = none(nil), 1 = bool, 2 = number(f64), 3 = string
 *   [payload]     // bool: u8 | number: f64le | string: u32 len + bytes | none: (empty)
 * ```
 *
 * @throws TypeError if an entry does not have exactly one of `value` / `returns`.
 */
export function encodeRedisProps(props: RedisProps | undefined): Buffer {
  const names = props ? Object.keys(props) : [];
  const header = Buffer.alloc(4);
  header.writeUInt32LE(names.length, 0);
  const parts: Buffer[] = [header];

  for (const name of names) {
    const prop = props![name] as Record<string, unknown>;
    const hasValue = Object.prototype.hasOwnProperty.call(prop, "value");
    const hasReturns = Object.prototype.hasOwnProperty.call(prop, "returns");
    if (hasValue === hasReturns) {
      throw new TypeError(
        `redisProps["${name}"] must have exactly one of "value" or "returns"`,
      );
    }

    const nameBuf = Buffer.from(name, "utf8");
    const nameHeader = Buffer.alloc(4);
    nameHeader.writeUInt32LE(nameBuf.length, 0);
    parts.push(nameHeader, nameBuf);

    const kind = hasValue ? PROP_KIND_FIELD : PROP_KIND_STUB;
    const raw = hasValue ? prop.value : prop.returns;
    parts.push(Buffer.from([kind]));
    parts.push(encodePropValue(raw, name, hasValue));
  }

  return Buffer.concat(parts);
}

/** Encodes the [vtype][payload] portion of one prop value. */
function encodePropValue(raw: unknown, name: string, isField: boolean): Buffer {
  if (raw === null || raw === undefined) {
    if (isField) {
      throw new TypeError(`redisProps["${name}"].value must not be null`);
    }
    return Buffer.from([PROP_VTYPE_NONE]);
  }
  if (typeof raw === "boolean") {
    return Buffer.from([PROP_VTYPE_BOOL, raw ? 1 : 0]);
  }
  if (typeof raw === "number") {
    const buf = Buffer.alloc(1 + 8);
    buf[0] = PROP_VTYPE_NUMBER;
    buf.writeDoubleLE(raw, 1);
    return buf;
  }
  if (typeof raw === "string") {
    const strBuf = Buffer.from(raw, "utf8");
    const buf = Buffer.alloc(1 + 4 + strBuf.length);
    buf[0] = PROP_VTYPE_STRING;
    buf.writeUInt32LE(strBuf.length, 1);
    strBuf.copy(buf, 5);
    return buf;
  }
  throw new TypeError(
    `redisProps["${name}"] value must be a string, number, boolean${isField ? "" : ", or null"}`,
  );
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
export function unpackPtrLen(
  result: bigint | number[] | { ptr: number; len: number },
): {
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
  if (
    result &&
    typeof result === "object" &&
    "ptr" in result &&
    "len" in result
  ) {
    return { ptr: Number(result.ptr), len: Number(result.len) };
  }
  throw new Error("Unexpected PtrLen return type");
}
