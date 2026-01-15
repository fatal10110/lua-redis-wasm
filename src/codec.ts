import type { ReplyValue } from "./types.js";

// Reply type tags used by the WASM ABI.
const REPLY_NULL = 0x00;
const REPLY_INT = 0x01;
const REPLY_BULK = 0x02;
const REPLY_ARRAY = 0x03;
const REPLY_STATUS = 0x04;
const REPLY_ERROR = 0x05;

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

function writeInt64LE(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  const big = typeof value === "bigint" ? value : BigInt(value);
  buf.writeBigInt64LE(big, 0);
  return buf;
}

// Encode a ReplyValue into the ABI wire format.
export function encodeReplyValue(value: ReplyValue): Buffer {
  if (value === null || value === undefined) {
    return Buffer.from([REPLY_NULL, 0, 0, 0, 0]);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const payload = writeInt64LE(value);
    const header = Buffer.alloc(5);
    header[0] = REPLY_INT;
    header.writeUInt32LE(payload.length, 1);
    return Buffer.concat([header, payload]);
  }
  if (Array.isArray(value)) {
    const items = value.map(encodeReplyValue);
    const header = Buffer.alloc(5);
    header[0] = REPLY_ARRAY;
    header.writeUInt32LE(items.length, 1);
    return Buffer.concat([header, ...items]);
  }
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
  const payload = ensureBuffer(value, "bulk reply");
  const header = Buffer.alloc(5);
  header[0] = REPLY_BULK;
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// Decode the ABI wire format into a ReplyValue tree.
export function decodeReply(buffer: Buffer, offset = 0): { value: ReplyValue; offset: number } {
  if (offset + 5 > buffer.length) {
    throw new Error("ERR reply decoding failed");
  }
  const type = buffer.readUInt8(offset);
  const countOrLen = buffer.readUInt32LE(offset + 1);
  let cursor = offset + 5;

  if (type === REPLY_NULL) {
    return { value: null, offset: cursor };
  }
  if (type === REPLY_INT) {
    if (cursor + 8 > buffer.length) {
      throw new Error("ERR reply decoding failed");
    }
    const big = buffer.readBigInt64LE(cursor);
    cursor += 8;
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

// Encode Redis arguments into the ArgArray ABI format.
export function encodeArgArray(args: Array<Buffer | Uint8Array | string>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(4);
  header.writeUInt32LE(args.length, 0);
  parts.push(header);
  for (const arg of args) {
    const buf = ensureBuffer(arg, "arg");
    const len = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    parts.push(len, buf);
  }
  return Buffer.concat(parts);
}

// Pack PtrLen into a single bigint (for non-sret ABI paths).
export function packPtrLen(ptr: number, len: number): bigint {
  return (BigInt(len) << 32n) | BigInt(ptr >>> 0);
}

// Unpack PtrLen from possible ABI return shapes.
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
