import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  EngineOptions,
  ReplyValue,
  RedisCallHandler,
  RedisHost,
  RedisLogHandler,
  StandaloneOptions
} from "./types.js";

const REPLY_NULL = 0x00;
const REPLY_INT = 0x01;
const REPLY_BULK = 0x02;
const REPLY_ARRAY = 0x03;
const REPLY_STATUS = 0x04;
const REPLY_ERROR = 0x05;

type PtrLen = { ptr: number; len: number };

type WasmExports = {
  memory: WebAssembly.Memory;
  init: () => number;
  reset: () => number;
  eval: (ptr: number, len: number) => bigint | number[] | PtrLen;
  eval_with_args: (
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number
  ) => bigint | number[] | PtrLen;
  alloc: (size: number) => number;
  free_mem: (ptr: number) => void;
};

function ensureBuffer(value: unknown, label: string): Buffer {
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

function encodeReplyValue(value: ReplyValue): Buffer {
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

function decodeReply(buffer: Buffer, offset = 0): { value: ReplyValue; offset: number } {
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

function encodeArgArray(args: Array<Buffer | Uint8Array | string>): Buffer {
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

function packPtrLen(ptr: number, len: number): bigint {
  return (BigInt(len) << 32n) | BigInt(ptr >>> 0);
}

function unpackPtrLen(result: bigint | number[] | PtrLen): PtrLen {
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

export class LuaWasmEngine {
  private instance: WebAssembly.Instance;
  private exports: WasmExports;
  private memory: WebAssembly.Memory;

  constructor(instance: WebAssembly.Instance, private options: EngineOptions | StandaloneOptions) {
    this.instance = instance;
    this.exports = instance.exports as WasmExports;
    this.memory = this.exports.memory;
  }

  static async create(options: EngineOptions): Promise<LuaWasmEngine> {
    return LuaWasmEngine.createWithHost(options);
  }

  static async createWithHost(options: EngineOptions): Promise<LuaWasmEngine> {
    const wasmBytes = options.wasmBytes
      ? options.wasmBytes
      : await fs.readFile(options.wasmPath ?? LuaWasmEngine.defaultWasmPath());

    const imports: WebAssembly.Imports = {
      env: {}
    };

    const instanceHolder: { instance: WebAssembly.Instance | null } = { instance: null };

    const readBytes = (ptr: number, len: number): Buffer => {
      const mem = new Uint8Array((instanceHolder.instance!.exports as WasmExports).memory.buffer);
      return Buffer.from(mem.subarray(ptr, ptr + len));
    };

    const writeBytes = (ptr: number, data: Buffer): void => {
      const mem = new Uint8Array((instanceHolder.instance!.exports as WasmExports).memory.buffer);
      mem.set(data, ptr);
    };

    const allocAndWrite = (data: Buffer): number => {
      const ptr = (instanceHolder.instance!.exports as WasmExports).alloc(data.length);
      writeBytes(ptr, data);
      return ptr;
    };

    const encodeAndReturn = (value: ReplyValue): bigint => {
      const encoded = encodeReplyValue(value);
      const ptr = allocAndWrite(encoded);
      return packPtrLen(ptr, encoded.length);
    };

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_log = (
      level: number,
      ptr: number,
      len: number
    ): void => {
      const msg = readBytes(ptr, len);
      options.host.log(level, msg);
    };

    (imports.env as Record<string, (...args: number[]) => number>).host_sha1hex = (
      ptr: number,
      len: number
    ): bigint => {
      const data = readBytes(ptr, len);
      const hex = createHash("sha1").update(data).digest("hex");
      const bytes = Buffer.from(hex, "utf8");
      return encodeAndReturn(bytes);
    };

    const callHandler = (args: Buffer[], isPcall: boolean): ReplyValue => {
      const handler = isPcall ? options.host.redisPcall : options.host.redisCall;
      try {
        return handler(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { err: Buffer.from(message, "utf8") };
      }
    };

    const decodeArgs = (ptr: number, len: number): Buffer[] => {
      const buf = readBytes(ptr, len);
      if (buf.length < 4) {
        throw new Error("ERR invalid argument encoding");
      }
      const count = buf.readUInt32LE(0);
      const out: Buffer[] = [];
      let offset = 4;
      for (let i = 0; i < count; i += 1) {
        if (offset + 4 > buf.length) {
          throw new Error("ERR invalid argument encoding");
        }
        const argLen = buf.readUInt32LE(offset);
        offset += 4;
        if (offset + argLen > buf.length) {
          throw new Error("ERR invalid argument encoding");
        }
        out.push(Buffer.from(buf.subarray(offset, offset + argLen)));
        offset += argLen;
      }
      return out;
    };

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_call = (
      ptr: number,
      len: number
    ): bigint => {
      const args = decodeArgs(ptr, len);
      return encodeAndReturn(callHandler(args, false));
    };

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_pcall = (
      ptr: number,
      len: number
    ): bigint => {
      const args = decodeArgs(ptr, len);
      return encodeAndReturn(callHandler(args, true));
    };

    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    instanceHolder.instance = instance;

    const engine = new LuaWasmEngine(instance, options);
    const initResult = engine.exports.init();
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
    return engine;
  }

  static async createStandalone(options: StandaloneOptions = {}): Promise<LuaWasmEngine> {
    const wasmBytes = options.wasmBytes
      ? options.wasmBytes
      : await fs.readFile(options.wasmPath ?? LuaWasmEngine.defaultWasmPath());

    const imports: WebAssembly.Imports = {
      env: {}
    };

    const instanceHolder: { instance: WebAssembly.Instance | null } = { instance: null };

    const readBytes = (ptr: number, len: number): Buffer => {
      const mem = new Uint8Array((instanceHolder.instance!.exports as WasmExports).memory.buffer);
      return Buffer.from(mem.subarray(ptr, ptr + len));
    };

    const writeBytes = (ptr: number, data: Buffer): void => {
      const mem = new Uint8Array((instanceHolder.instance!.exports as WasmExports).memory.buffer);
      mem.set(data, ptr);
    };

    const allocAndWrite = (data: Buffer): number => {
      const ptr = (instanceHolder.instance!.exports as WasmExports).alloc(data.length);
      writeBytes(ptr, data);
      return ptr;
    };

    const encodeAndReturn = (value: ReplyValue): bigint => {
      const encoded = encodeReplyValue(value);
      const ptr = allocAndWrite(encoded);
      return packPtrLen(ptr, encoded.length);
    };

    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(`ERR ${action} is not available in standalone mode`, "utf8")
    });

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_log = (
      _level: number,
      _ptr: number,
      _len: number
    ): void => {};

    (imports.env as Record<string, (...args: number[]) => number>).host_sha1hex = (
      ptr: number,
      len: number
    ): bigint => {
      const data = readBytes(ptr, len);
      const hex = createHash("sha1").update(data).digest("hex");
      const bytes = Buffer.from(hex, "utf8");
      return encodeAndReturn(bytes);
    };

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_call = (
      _ptr: number,
      _len: number
    ): bigint => encodeAndReturn(notSupported("redis.call"));

    (imports.env as Record<string, (...args: number[]) => number>).host_redis_pcall = (
      _ptr: number,
      _len: number
    ): bigint => encodeAndReturn(notSupported("redis.pcall"));

    const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
    instanceHolder.instance = instance;

    const engine = new LuaWasmEngine(instance, options);
    const initResult = engine.exports.init();
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
    return engine;
  }

  static defaultWasmPath(): string {
    return path.resolve("wasm/build/redis_lua.wasm");
  }

  eval(script: Buffer | Uint8Array | string): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const ptr = this.exports.alloc(scriptBuf.length);
    const mem = new Uint8Array(this.memory.buffer);
    mem.set(scriptBuf, ptr);
    const result = this.exports.eval(ptr, scriptBuf.length);
    this.exports.free_mem(ptr);
    return this.decodeResult(result);
  }

  evalWithArgs(
    script: Buffer | Uint8Array | string,
    keys: Array<Buffer | Uint8Array | string> = [],
    args: Array<Buffer | Uint8Array | string> = []
  ): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const argBuf = encodeArgArray([...keys, ...args]);
    const scriptPtr = this.exports.alloc(scriptBuf.length);
    const argsPtr = this.exports.alloc(argBuf.length);
    const mem = new Uint8Array(this.memory.buffer);
    mem.set(scriptBuf, scriptPtr);
    mem.set(argBuf, argsPtr);
    const result = this.exports.eval_with_args(
      scriptPtr,
      scriptBuf.length,
      argsPtr,
      argBuf.length,
      keys.length
    );
    this.exports.free_mem(scriptPtr);
    this.exports.free_mem(argsPtr);
    return this.decodeResult(result);
  }

  private decodeResult(result: bigint | number[] | PtrLen): ReplyValue {
    const { ptr, len } = unpackPtrLen(result);
    if (!ptr || !len) {
      return null;
    }
    const mem = new Uint8Array(this.memory.buffer);
    const buffer = Buffer.from(mem.subarray(ptr, ptr + len));
    this.exports.free_mem(ptr);
    return decodeReply(buffer).value;
  }
}

export type {
  EngineOptions,
  ReplyValue,
  RedisCallHandler,
  RedisHost,
  RedisLogHandler,
  StandaloneOptions
};

export function encodeReply(value: ReplyValue): Buffer {
  return encodeReplyValue(value);
}

export function decodeReplyBuffer(buffer: Buffer): ReplyValue {
  return decodeReply(buffer).value;
}

export function encodeArgs(args: Array<Buffer | Uint8Array | string>): Buffer {
  return encodeArgArray(args);
}
