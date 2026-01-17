/**
 * @fileoverview Main LuaWasmEngine class for executing Redis Lua scripts.
 *
 * This module provides the primary API for the redis-lua-wasm package:
 * - `LuaWasmEngine.create()` - Create engine with Redis host integration
 * - `LuaWasmEngine.createStandalone()` - Create engine without host
 *
 * ## Architecture
 *
 * The engine manages the lifecycle of a Lua 5.1 VM running in WebAssembly:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    LuaWasmEngine                            │
 * │  - eval(script)                                             │
 * │  - evalWithArgs(script, keys, args)                         │
 * └─────────────────────┬───────────────────────────────────────┘
 *                       │
 *     ┌─────────────────┼─────────────────┐
 *     │                 │                 │
 *     ▼                 ▼                 ▼
 * ┌────────┐      ┌──────────┐      ┌──────────┐
 * │ codec  │      │  loader  │      │   WASM   │
 * │ encode │      │  module  │      │   Lua    │
 * │ decode │      │  loader  │      │  runtime │
 * └────────┘      └──────────┘      └──────────┘
 * ```
 *
 * ## Host Callbacks
 *
 * When Lua code calls `redis.call()`, `redis.pcall()`, `redis.log()`, or
 * `redis.sha1hex()`, the WASM module invokes host-provided callbacks:
 *
 * - `host_redis_call` - Handles redis.call() (may throw)
 * - `host_redis_pcall` - Handles redis.pcall() (returns errors)
 * - `host_redis_log` - Handles redis.log() messages
 * - `host_sha1hex` - Computes SHA1 hex digest
 *
 * @module engine
 */

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
  ensureBuffer,
  unpackPtrLen
} from "./codec.js";
import { loadModule, type HostImport, type WasmExports, defaultModulePath, defaultWasmPath } from "./loader.js";
import {
  readBytes,
  allocAndWrite,
  encodeReplyToPtrLen,
  parseAbiArgs,
  returnPtrLen,
  decodeArgs,
  computeSha1Hex
} from "./helpers.js";

/**
 * Redis Lua WASM Engine for executing Lua scripts in Node.js.
 *
 * This class provides a Redis-compatible Lua 5.1 execution environment
 * powered by WebAssembly. It supports:
 * - Binary-safe script evaluation
 * - KEYS/ARGV injection
 * - redis.call/pcall host integration
 * - Resource limits (fuel, memory, reply size)
 *
 * ## Creating an Engine
 *
 * Use the static factory methods to create instances:
 *
 * ```typescript
 * // With Redis host integration
 * const engine = await LuaWasmEngine.create({
 *   host: {
 *     redisCall(args) { ... },
 *     redisPcall(args) { ... },
 *     log(level, msg) { ... }
 *   }
 * });
 *
 * // Standalone (no Redis commands)
 * const standalone = await LuaWasmEngine.createStandalone({});
 * ```
 *
 * ## Evaluating Scripts
 *
 * ```typescript
 * // Simple evaluation
 * engine.eval("return 1 + 1");  // Returns: 2
 *
 * // With KEYS and ARGV
 * engine.evalWithArgs(
 *   "return {KEYS[1], ARGV[1]}",
 *   [Buffer.from("key")],
 *   [Buffer.from("arg")]
 * );
 * ```
 */
export class LuaWasmEngine {
  /** Reference to WASM module exports */
  private exports: WasmExports;

  /** Configured resource limits */
  private limits: EngineLimits | undefined;

  /**
   * Private constructor - use static factory methods instead.
   * @internal
   */
  constructor(exports: WasmExports, private options: EngineOptions | StandaloneOptions) {
    this.exports = exports;
    this.limits = options.limits;
  }

  /**
   * Creates a new engine with full Redis host integration.
   *
   * This is the primary factory method for creating engines that support
   * `redis.call()`, `redis.pcall()`, and `redis.log()` from Lua scripts.
   *
   * @param options - Engine configuration with host callbacks
   * @returns Promise resolving to initialized engine
   *
   * @example
   * ```typescript
   * const engine = await LuaWasmEngine.create({
   *   host: {
   *     redisCall(args) {
   *       const cmd = args[0].toString().toUpperCase();
   *       if (cmd === "PING") return { ok: Buffer.from("PONG") };
   *       throw new Error("ERR unknown command");
   *     },
   *     redisPcall(args) {
   *       try { return this.redisCall(args); }
   *       catch (e) { return { err: Buffer.from(e.message) }; }
   *     },
   *     log(level, msg) { console.log(msg.toString()); }
   *   },
   *   limits: { maxFuel: 10_000_000 }
   * });
   * ```
   */
  static async create(options: EngineOptions): Promise<LuaWasmEngine> {
    return LuaWasmEngine.createWithHost(options);
  }

  /**
   * Creates engine with host callbacks for redis.call/pcall/log/sha1hex.
   *
   * This method sets up the WASM module with host import functions that
   * bridge Lua's redis API to the JavaScript host. The host imports handle:
   *
   * - `host_redis_call` - Dispatches to host.redisCall()
   * - `host_redis_pcall` - Dispatches to host.redisPcall()
   * - `host_redis_log` - Dispatches to host.log()
   * - `host_sha1hex` - Computes SHA1 using Node.js crypto
   *
   * @param options - Engine configuration with host callbacks
   * @returns Promise resolving to initialized engine
   */
  static async createWithHost(options: EngineOptions): Promise<LuaWasmEngine> {
    const hostImports: Record<string, HostImport> = {};
    let exportsRef: WasmExports | null = null;

    const getExports = (): WasmExports => {
      if (!exportsRef) throw new Error("WASM module not initialized");
      return exportsRef;
    };

    /**
     * Internal handler for redis.call/pcall dispatch.
     * Routes to the appropriate host handler and catches errors.
     */
    const callHandler = (args: Buffer[], isPcall: boolean): ReplyValue => {
      try {
        return isPcall
          ? options.host.redisPcall.call(options.host, args)
          : options.host.redisCall.call(options.host, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { err: Buffer.from(message, "utf8") };
      }
    };

    // Host import: redis.log(level, msg)
    hostImports.host_redis_log = (level: number, ptr: number, len: number): void => {
      const msg = readBytes(getExports().HEAPU8, ptr, len);
      options.host.log(level, msg);
    };

    // Host import: redis.sha1hex(buffer) -> hex string
    hostImports.host_sha1hex = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const data = readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len);
      const bytes = computeSha1Hex(data);
      const ptrLen = { ptr: allocAndWrite(exports, bytes), len: bytes.length };
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    // Host import: redis.call(...) -> ReplyValue
    hostImports.host_redis_call = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const decoded = decodeArgs(readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len));
      const ptrLen = encodeReplyToPtrLen(exports, callHandler(decoded, false));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    // Host import: redis.pcall(...) -> ReplyValue
    hostImports.host_redis_pcall = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const decoded = decodeArgs(readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len));
      const ptrLen = encodeReplyToPtrLen(exports, callHandler(decoded, true));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    const { exports } = await loadModule(options, hostImports);
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

  /**
   * Creates a standalone engine without Redis host integration.
   *
   * In standalone mode, `redis.call()` and `redis.pcall()` return errors.
   * This is useful for running pure Lua computations or testing.
   *
   * @param options - Optional configuration (paths, limits)
   * @returns Promise resolving to initialized engine
   *
   * @example
   * ```typescript
   * const engine = await LuaWasmEngine.createStandalone({
   *   limits: { maxFuel: 1_000_000 }
   * });
   *
   * engine.eval("return math.sqrt(16)");  // Returns: 4
   * engine.eval("redis.call('PING')");    // Returns: {err: "ERR..."}
   * ```
   */
  static async createStandalone(options: StandaloneOptions = {}): Promise<LuaWasmEngine> {
    const hostImports: Record<string, HostImport> = {};
    let exportsRef: WasmExports | null = null;

    const getExports = (): WasmExports => {
      if (!exportsRef) throw new Error("WASM module not initialized");
      return exportsRef;
    };

    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(`ERR ${action} is not available in standalone mode`, "utf8")
    });

    // Standalone host imports - log is no-op, redis.call/pcall return errors
    hostImports.host_redis_log = (_level: number, _ptr: number, _len: number): void => {};

    hostImports.host_sha1hex = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const data = readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len);
      const bytes = computeSha1Hex(data);
      const ptrLen = { ptr: allocAndWrite(exports, bytes), len: bytes.length };
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    hostImports.host_redis_call = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const ptrLen = encodeReplyToPtrLen(exports, notSupported("redis.call"));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    hostImports.host_redis_pcall = (...args: number[]): bigint | void => {
      const exports = getExports();
      const abiArgs = parseAbiArgs(args);
      const ptrLen = encodeReplyToPtrLen(exports, notSupported("redis.pcall"));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    const { exports } = await loadModule(options, hostImports);
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

  /**
   * Returns the default path to the bundled WASM binary.
   * @returns Absolute path to redis_lua.wasm
   */
  static defaultWasmPath(): string {
    return defaultWasmPath();
  }

  /**
   * Returns the default path to the bundled Emscripten JS module.
   * @returns Absolute path to redis_lua.mjs
   */
  static defaultModulePath(): string {
    return defaultModulePath();
  }

  /**
   * Returns the configured resource limits, if any.
   * @returns EngineLimits object or undefined if no limits configured
   */
  getLimits(): EngineLimits | undefined {
    return this.limits;
  }

  /**
   * Evaluates a Lua script and returns the result.
   *
   * The script is executed in a fresh Lua environment. Return values
   * are converted to JavaScript types:
   * - Lua numbers -> JavaScript number or bigint
   * - Lua strings -> Buffer (binary-safe)
   * - Lua tables -> Array
   * - Lua nil -> null
   *
   * @param script - Lua source code as string, Buffer, or Uint8Array
   * @returns The script's return value as a ReplyValue
   *
   * @example
   * ```typescript
   * engine.eval("return 1 + 1");           // 2
   * engine.eval("return 'hello'");         // Buffer.from("hello")
   * engine.eval("return {1, 2, 3}");       // [1, 2, 3]
   * engine.eval("return redis.call('PING')"); // {ok: Buffer.from("PONG")}
   * ```
   */
  eval(script: Buffer | Uint8Array | string): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const ptr = this.exports._alloc(scriptBuf.length);
    this.exports.HEAPU8.set(scriptBuf, ptr);
    const result = this.callEval(ptr, scriptBuf.length);
    this.exports._free_mem(ptr);
    return this.decodeResult(result);
  }

  /**
   * Evaluates a Lua script with KEYS and ARGV arrays injected.
   *
   * This matches Redis's EVALSHA/EVAL interface. The KEYS and ARGV
   * globals are populated before script execution and are binary-safe.
   *
   * @param script - Lua source code
   * @param keys - Array of KEYS values (typically key names)
   * @param args - Array of ARGV values (additional arguments)
   * @returns The script's return value as a ReplyValue
   *
   * @example
   * ```typescript
   * engine.evalWithArgs(
   *   "return {KEYS[1], ARGV[1]}",
   *   [Buffer.from("user:1")],
   *   [Buffer.from("active")]
   * );
   * // Returns: [Buffer.from("user:1"), Buffer.from("active")]
   * ```
   */
  evalWithArgs(
    script: Buffer | Uint8Array | string,
    keys: Array<Buffer | Uint8Array | string> = [],
    args: Array<Buffer | Uint8Array | string> = []
  ): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const argBuf = encodeArgArray([...keys, ...args]);

    // Enforce maxArgBytes limit on host side
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

  /**
   * Calls the WASM _eval function, handling different ABI conventions.
   *
   * The ABI may use either:
   * - Direct return: Returns packed bigint (ptr|len)
   * - Sret: Writes to hidden return pointer parameter
   *
   * @param ptr - Pointer to script in linear memory
   * @param len - Script byte length
   * @returns PtrLen result in one of several formats
   * @private
   */
  private callEval(ptr: number, len: number): bigint | number[] | { ptr: number; len: number } | number {
    // Check if function expects sret (3+ params means first is return ptr)
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

  /**
   * Calls the WASM _eval_with_args function with KEYS/ARGV.
   *
   * @param scriptPtr - Pointer to script bytes
   * @param scriptLen - Script byte length
   * @param argsPtr - Pointer to encoded ArgArray
   * @param argsLen - ArgArray byte length
   * @param keysCount - Number of KEYS (rest are ARGV)
   * @returns PtrLen result
   * @private
   */
  private callEvalWithArgs(
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number
  ): bigint | number[] | { ptr: number; len: number } | number {
    // Check for sret ABI (6+ params)
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

  /**
   * Reads a PtrLen struct from WASM memory.
   * Layout: [ptr: u32le][len: u32le]
   *
   * @param base - Base pointer to the struct
   * @returns Object with ptr and len fields
   * @private
   */
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

  /**
   * Decodes a PtrLen result from WASM into a ReplyValue.
   *
   * Handles various result formats and applies maxReplyBytes limit.
   *
   * @param result - Raw result from WASM function
   * @returns Decoded ReplyValue
   * @private
   */
  private decodeResult(result: bigint | number[] | { ptr: number; len: number } | number): ReplyValue {
    let ptrLen: { ptr: number; len: number };

    // Handle different result formats
    if (typeof result === "number") {
      // Legacy Emscripten returns ptr in function result, len via getTempRet0
      if (this.exports.getTempRet0) {
        const len = this.exports.getTempRet0();
        if (!len) {
          throw new Error("Unexpected PtrLen return type");
        }
        ptrLen = { ptr: result >>> 0, len };
      } else {
        // Result is a pointer to PtrLen struct
        ptrLen = this.readPtrLen(result >>> 0);
      }
    } else {
      ptrLen = unpackPtrLen(result);
    }

    const { ptr, len } = ptrLen;

    // Null result (ptr=0 or len=0)
    if (!ptr || !len) {
      return null;
    }

    // Enforce maxReplyBytes limit
    if (this.limits?.maxReplyBytes && len > this.limits.maxReplyBytes) {
      this.exports._free_mem(ptr);
      return { err: Buffer.from("ERR reply exceeds configured limit", "utf8") };
    }

    // Read and decode the reply buffer
    const buffer = Buffer.from(this.exports.HEAPU8.subarray(ptr, ptr + len));
    this.exports._free_mem(ptr);
    return decodeReply(buffer).value;
  }
}

export type { EngineOptions, ReplyValue, RedisCallHandler, RedisHost, RedisLogHandler, StandaloneOptions };
