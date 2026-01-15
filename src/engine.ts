import { createHash } from "node:crypto";

import type {
  EngineLimits,
  EngineOptions,
  ReplyValue,
  RedisHost,
  RedisCallHandler,
  RedisLogHandler,
  StandaloneOptions
} from "./types.js";
import {
  decodeReply,
  encodeArgArray,
  encodeReplyValue,
  ensureBuffer,
  packPtrLen,
  unpackPtrLen
} from "./codec.js";
import { loadModule, type HostImport, type WasmExports, defaultModulePath, defaultWasmPath } from "./loader.js";

export class LuaWasmEngine {
  private exports: WasmExports;
  private limits: EngineLimits | undefined;

  constructor(exports: WasmExports, private options: EngineOptions | StandaloneOptions) {
    this.exports = exports;
    this.limits = options.limits;
  }

  // Full host-integrated engine (redis.call/pcall are supported).
  static async create(options: EngineOptions): Promise<LuaWasmEngine> {
    return LuaWasmEngine.createWithHost(options);
  }

  // Emscripten module with host callbacks for redis.call/pcall/log/sha1hex.
  static async createWithHost(options: EngineOptions): Promise<LuaWasmEngine> {
    const hostImports: Record<string, HostImport> = {};
    let moduleRef: WasmExports | null = null;
    let exportsRef: WasmExports | null = null;

    // Memory helpers (binary-safe, no string coercion).
    const readBytes = (ptr: number, len: number): Buffer => {
      if (!moduleRef) {
        throw new Error("WASM module not initialized");
      }
      const mem = moduleRef.HEAPU8;
      return Buffer.from(mem.subarray(ptr, ptr + len));
    };

    const writeBytes = (ptr: number, data: Buffer): void => {
      if (!moduleRef) {
        throw new Error("WASM module not initialized");
      }
      moduleRef.HEAPU8.set(data, ptr);
    };

    const allocAndWrite = (data: Buffer): number => {
      if (!exportsRef) {
        throw new Error("WASM module not initialized");
      }
      const ptr = exportsRef._alloc(data.length);
      writeBytes(ptr, data);
      return ptr;
    };

    // Encode a ReplyValue and return PtrLen to WASM memory.
    const encodeReplyToPtrLen = (value: ReplyValue): { ptr: number; len: number } => {
      const encoded = encodeReplyValue(value);
      const ptr = allocAndWrite(encoded);
      return { ptr, len: encoded.length };
    };

    // Write PtrLen into WASM memory (sret layout: ptr,u32 + len,u32).
    const writePtrLen = (retPtr: number, ptrLen: { ptr: number; len: number }): void => {
      const heap = moduleRef!.HEAPU8;
      heap[retPtr] = ptrLen.ptr & 0xff;
      heap[retPtr + 1] = (ptrLen.ptr >> 8) & 0xff;
      heap[retPtr + 2] = (ptrLen.ptr >> 16) & 0xff;
      heap[retPtr + 3] = (ptrLen.ptr >> 24) & 0xff;
      heap[retPtr + 4] = ptrLen.len & 0xff;
      heap[retPtr + 5] = (ptrLen.len >> 8) & 0xff;
      heap[retPtr + 6] = (ptrLen.len >> 16) & 0xff;
      heap[retPtr + 7] = (ptrLen.len >> 24) & 0xff;
    };

    // Host import: redis.log(level, msg)
    hostImports.host_redis_log = (level: number, ptr: number, len: number): void => {
      const msg = readBytes(ptr, len);
      options.host.log(level, msg);
    };

    // Host import: sha1hex(buffer) -> PtrLen (sret or packed).
    hostImports.host_sha1hex = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptr = hasRet ? args[1] : args[0];
      const len = hasRet ? args[2] : args[1];
      const data = readBytes(ptr, len);
      const hex = createHash("sha1").update(data).digest("hex");
      const bytes = Buffer.from(hex, "utf8");
      const ptrLen = encodeReplyToPtrLen(bytes);
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    // Redis command dispatch. pcall returns error replies instead of throwing.
    const callHandler = (args: Buffer[], isPcall: boolean): ReplyValue => {
      const handler = isPcall ? options.host.redisPcall : options.host.redisCall;
      try {
        return handler(args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { err: Buffer.from(message, "utf8") };
      }
    };

    // Decode ArgArray payload into Buffer arguments.
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

    // Host import: redis.call(...) -> ReplyValue.
    hostImports.host_redis_call = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptr = hasRet ? args[1] : args[0];
      const len = hasRet ? args[2] : args[1];
      const decoded = decodeArgs(ptr, len);
      const ptrLen = encodeReplyToPtrLen(callHandler(decoded, false));
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    // Host import: redis.pcall(...) -> ReplyValue.
    hostImports.host_redis_pcall = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptr = hasRet ? args[1] : args[0];
      const len = hasRet ? args[2] : args[1];
      const decoded = decodeArgs(ptr, len);
      const ptrLen = encodeReplyToPtrLen(callHandler(decoded, true));
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    const { module, exports } = await loadModule(options, hostImports);
    moduleRef = module;
    exportsRef = exports;

    const engine = new LuaWasmEngine(exports, options);
    if (engine.exports._set_limits && options.limits) {
      engine.exports._set_limits(
        options.limits.maxFuel ?? 0,
        options.limits.maxReplyBytes ?? 0,
        options.limits.maxArgBytes ?? 0
      );
    }
    const initResult = engine.exports._init();
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
    return engine;
  }

  // Standalone engine (redis.call/pcall return errors).
  static async createStandalone(options: StandaloneOptions = {}): Promise<LuaWasmEngine> {
    const hostImports: Record<string, HostImport> = {};
    let moduleRef: WasmExports | null = null;
    let exportsRef: WasmExports | null = null;

    const readBytes = (ptr: number, len: number): Buffer => {
      if (!moduleRef) {
        throw new Error("WASM module not initialized");
      }
      const mem = moduleRef.HEAPU8;
      return Buffer.from(mem.subarray(ptr, ptr + len));
    };

    const writeBytes = (ptr: number, data: Buffer): void => {
      if (!moduleRef) {
        throw new Error("WASM module not initialized");
      }
      moduleRef.HEAPU8.set(data, ptr);
    };

    const allocAndWrite = (data: Buffer): number => {
      if (!exportsRef) {
        throw new Error("WASM module not initialized");
      }
      const ptr = exportsRef._alloc(data.length);
      writeBytes(ptr, data);
      return ptr;
    };

    const encodeReplyToPtrLen = (value: ReplyValue): { ptr: number; len: number } => {
      const encoded = encodeReplyValue(value);
      const ptr = allocAndWrite(encoded);
      return { ptr, len: encoded.length };
    };

    // Write PtrLen into WASM memory (sret layout: ptr,u32 + len,u32).
    const writePtrLen = (retPtr: number, ptrLen: { ptr: number; len: number }): void => {
      const heap = moduleRef!.HEAPU8;
      heap[retPtr] = ptrLen.ptr & 0xff;
      heap[retPtr + 1] = (ptrLen.ptr >> 8) & 0xff;
      heap[retPtr + 2] = (ptrLen.ptr >> 16) & 0xff;
      heap[retPtr + 3] = (ptrLen.ptr >> 24) & 0xff;
      heap[retPtr + 4] = ptrLen.len & 0xff;
      heap[retPtr + 5] = (ptrLen.len >> 8) & 0xff;
      heap[retPtr + 6] = (ptrLen.len >> 16) & 0xff;
      heap[retPtr + 7] = (ptrLen.len >> 24) & 0xff;
    };

    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(`ERR ${action} is not available in standalone mode`, "utf8")
    });

    hostImports.host_redis_log = (_level: number, _ptr: number, _len: number): void => {};

    hostImports.host_sha1hex = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptr = hasRet ? args[1] : args[0];
      const len = hasRet ? args[2] : args[1];
      const data = readBytes(ptr, len);
      const hex = createHash("sha1").update(data).digest("hex");
      const bytes = Buffer.from(hex, "utf8");
      const ptrLen = encodeReplyToPtrLen(bytes);
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    hostImports.host_redis_call = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptrLen = encodeReplyToPtrLen(notSupported("redis.call"));
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    hostImports.host_redis_pcall = (...args: number[]): bigint | void => {
      const hasRet = args.length >= 3;
      const retPtr = hasRet ? args[0] : 0;
      const ptrLen = encodeReplyToPtrLen(notSupported("redis.pcall"));
      if (hasRet) {
        writePtrLen(retPtr, ptrLen);
        return;
      }
      return packPtrLen(ptrLen.ptr, ptrLen.len);
    };

    const { module, exports } = await loadModule(options, hostImports);
    moduleRef = module;
    exportsRef = exports;

    const engine = new LuaWasmEngine(exports, options);
    if (engine.exports._set_limits && options.limits) {
      engine.exports._set_limits(
        options.limits.maxFuel ?? 0,
        options.limits.maxReplyBytes ?? 0,
        options.limits.maxArgBytes ?? 0
      );
    }
    const initResult = engine.exports._init();
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
    return engine;
  }

  static defaultWasmPath(): string {
    return defaultWasmPath();
  }

  static defaultModulePath(): string {
    return defaultModulePath();
  }

  getLimits(): EngineLimits | undefined {
    return this.limits;
  }

  // Evaluate a script without KEYS/ARGV injection.
  eval(script: Buffer | Uint8Array | string): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const ptr = this.exports._alloc(scriptBuf.length);
    this.exports.HEAPU8.set(scriptBuf, ptr);
    const result = this.callEval(ptr, scriptBuf.length);
    this.exports._free_mem(ptr);
    return this.decodeResult(result);
  }

  // Evaluate a script with KEYS/ARGV injection (binary-safe).
  evalWithArgs(
    script: Buffer | Uint8Array | string,
    keys: Array<Buffer | Uint8Array | string> = [],
    args: Array<Buffer | Uint8Array | string> = []
  ): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const argBuf = encodeArgArray([...keys, ...args]);
    if (this.limits?.maxArgBytes && argBuf.length > this.limits.maxArgBytes) {
      return { err: Buffer.from("ERR KEYS/ARGV exceeds configured limit", "utf8") };
    }
    const scriptPtr = this.exports._alloc(scriptBuf.length);
    const argsPtr = this.exports._alloc(argBuf.length);
    this.exports.HEAPU8.set(scriptBuf, scriptPtr);
    this.exports.HEAPU8.set(argBuf, argsPtr);
    const result = this.callEvalWithArgs(
      scriptPtr,
      scriptBuf.length,
      argsPtr,
      argBuf.length,
      keys.length
    );
    this.exports._free_mem(scriptPtr);
    this.exports._free_mem(argsPtr);
    return this.decodeResult(result);
  }

  // Call into WASM with either direct or sret-style ABI.
  private callEval(ptr: number, len: number): bigint | number[] | { ptr: number; len: number } | number {
    if (this.exports._eval.length >= 3) {
      const retPtr = this.exports._alloc(8);
      this.exports._eval(retPtr, ptr, len);
      const ptrLen = this.readPtrLen(retPtr);
      this.exports._free_mem(retPtr);
      return ptrLen;
    }
    const result = this.exports._eval(ptr, len);
    if (result === undefined) {
      throw new Error("Unexpected PtrLen return type");
    }
    return result;
  }

  // Call into WASM with KEYS/ARGV, handling sret if required.
  private callEvalWithArgs(
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number
  ): bigint | number[] | { ptr: number; len: number } | number {
    if (this.exports._eval_with_args.length >= 6) {
      const retPtr = this.exports._alloc(8);
      this.exports._eval_with_args(retPtr, scriptPtr, scriptLen, argsPtr, argsLen, keysCount);
      const ptrLen = this.readPtrLen(retPtr);
      this.exports._free_mem(retPtr);
      return ptrLen;
    }
    const result = this.exports._eval_with_args(scriptPtr, scriptLen, argsPtr, argsLen, keysCount);
    if (result === undefined) {
      throw new Error("Unexpected PtrLen return type");
    }
    return result;
  }

  // Read PtrLen from WASM memory (little-endian u32 ptr + u32 len).
  private readPtrLen(base: number): { ptr: number; len: number } {
    const heap = this.exports.HEAPU8;
    if (base + 8 > heap.length) {
      throw new Error("Unexpected PtrLen return type");
    }
    const ptr =
      heap[base] |
      (heap[base + 1] << 8) |
      (heap[base + 2] << 16) |
      (heap[base + 3] << 24);
    const len =
      heap[base + 4] |
      (heap[base + 5] << 8) |
      (heap[base + 6] << 16) |
      (heap[base + 7] << 24);
    return { ptr, len };
  }

  // Decode PtrLen result into a ReplyValue.
  private decodeResult(result: bigint | number[] | { ptr: number; len: number } | number): ReplyValue {
    let ptrLen: { ptr: number; len: number };
    if (typeof result === "number") {
      if (this.exports.getTempRet0) {
        const len = this.exports.getTempRet0();
        if (!len) {
          throw new Error("Unexpected PtrLen return type");
        }
        ptrLen = { ptr: result >>> 0, len };
      } else {
        ptrLen = this.readPtrLen(result >>> 0);
      }
    } else {
      ptrLen = unpackPtrLen(result);
    }
    const { ptr, len } = ptrLen;
    if (!ptr || !len) {
      return null;
    }
    if (this.limits?.maxReplyBytes && len > this.limits.maxReplyBytes) {
      this.exports._free_mem(ptr);
      return { err: Buffer.from("ERR reply exceeds configured limit", "utf8") };
    }
    const buffer = Buffer.from(this.exports.HEAPU8.subarray(ptr, ptr + len));
    this.exports._free_mem(ptr);
    return decodeReply(buffer).value;
  }
}

export type { EngineOptions, ReplyValue, RedisCallHandler, RedisHost, RedisLogHandler, StandaloneOptions };
