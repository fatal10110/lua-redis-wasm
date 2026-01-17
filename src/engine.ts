/**
 * @fileoverview Main API for executing Redis Lua scripts in WebAssembly.
 *
 * This module provides the primary API for the redis-lua-wasm package:
 * - `load()` - Async function to load the WASM module
 * - `LuaWasmModule` - Factory for creating engine instances
 * - `LuaEngine` - Executes Lua scripts
 * - `LuaWasmEngine` - Convenience API (combines load and create)
 *
 * ## Architecture
 *
 * The API separates async loading from sync execution:
 *
 * ```
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      load(options)                          │
 * │  - Async WASM loading                                       │
 * │  - Returns LuaWasmModule                                    │
 * └─────────────────────┬───────────────────────────────────────┘
 *                       │
 *                       ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                    LuaWasmModule                            │
 * │  - create(host) → LuaEngine                                 │
 * │  - createStandalone() → LuaEngine                           │
 * │  - One-time use (consumed after create)                     │
 * └─────────────────────┬───────────────────────────────────────┘
 *                       │
 *                       ▼
 * ┌─────────────────────────────────────────────────────────────┐
 * │                      LuaEngine                              │
 * │  - eval(script)                                             │
 * │  - evalWithArgs(script, keys, args)                         │
 * └─────────────────────────────────────────────────────────────┘
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
  LoadOptions,
  ReplyValue,
  RedisHost,
  RedisCallHandler,
  RedisLogHandler,
  EngineOptions,
  StandaloneOptions,
} from "./types.js";
import {
  decodeReply,
  encodeArgArray,
  ensureBuffer,
  unpackPtrLen,
} from "./codec.js";
import {
  loadModule,
  type HostImport,
  type WasmExports,
  defaultModulePath,
  defaultWasmPath,
} from "./loader.js";
import {
  readBytes,
  allocAndWrite,
  encodeReplyToPtrLen,
  parseAbiArgs,
  returnPtrLen,
  decodeArgs,
  computeSha1Hex,
} from "./helpers.js";

/**
 * Lua script execution engine.
 *
 * This class provides methods to evaluate Lua scripts. Instances are created
 * via `LuaWasmModule` or `LuaWasmEngine`.
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
export class LuaEngine {
  /**
   * @internal
   */
  constructor(
    private exports: WasmExports,
    private limits: EngineLimits | undefined,
  ) {}

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
    const sha = computeSha1Hex(scriptBuf).toString("utf8");
    const ptr = this.exports._alloc(scriptBuf.length);
    this.exports.HEAPU8.set(scriptBuf, ptr);
    const result = this.callEval(ptr, scriptBuf.length);
    this.exports._free_mem(ptr);
    return this.decodeResult(result, sha);
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
    args: Array<Buffer | Uint8Array | string> = [],
  ): ReplyValue {
    const scriptBuf = ensureBuffer(script, "script");
    const sha = computeSha1Hex(scriptBuf).toString("utf8");
    const argBuf = encodeArgArray([...keys, ...args]);

    // Enforce maxArgBytes limit on host side
    if (this.limits?.maxArgBytes && argBuf.length > this.limits.maxArgBytes) {
      return {
        err: Buffer.from("ERR KEYS/ARGV exceeds configured limit", "utf8"),
      };
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
      keys.length,
    );

    this.exports._free_mem(scriptPtr);
    this.exports._free_mem(argsPtr);
    return this.decodeResult(result, sha);
  }

  /**
   * Calls the WASM _eval function, handling different ABI conventions.
   * @private
   */
  private callEval(
    ptr: number,
    len: number,
  ): bigint | number[] | { ptr: number; len: number } | number {
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
   * @private
   */
  private callEvalWithArgs(
    scriptPtr: number,
    scriptLen: number,
    argsPtr: number,
    argsLen: number,
    keysCount: number,
  ): bigint | number[] | { ptr: number; len: number } | number {
    if (this.exports._eval_with_args.length >= 6) {
      const retPtr = this.exports._alloc(8);
      this.exports._eval_with_args(
        retPtr,
        scriptPtr,
        scriptLen,
        argsPtr,
        argsLen,
        keysCount,
      );
      const ptrLen = this.readPtrLen(retPtr);
      this.exports._free_mem(retPtr);
      return ptrLen;
    }
    const result = this.exports._eval_with_args(
      scriptPtr,
      scriptLen,
      argsPtr,
      argsLen,
      keysCount,
    );
    if (result === undefined) {
      throw new Error("Unexpected PtrLen return type");
    }
    return result;
  }

  /**
   * Reads a PtrLen struct from WASM memory.
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
   * @private
   */
  private decodeResult(
    result: bigint | number[] | { ptr: number; len: number } | number,
    sha: string,
  ): ReplyValue {
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
    const value = decodeReply(buffer).value;

    // Format Lua script errors to match Redis format
    // Lua errors look like: "user_script:N: message"
    if (value && typeof value === "object" && "err" in value) {
      const errStr = value.err.toString("utf8");
      if (errStr.startsWith("user_script:")) {
        // Extract line number: "user_script:N: message" -> N
        const colonIdx = errStr.indexOf(":", 12); // after "user_script:"
        const line = colonIdx > 12 ? errStr.substring(12, colonIdx) : "1";
        const formatted = `${errStr} script: ${sha}, on @user_script:${line}.`;
        return { err: Buffer.from(formatted, "utf8") };
      }
    }

    return value;
  }
}

/**
 * Mutable handlers that can be swapped after WASM instantiation.
 * The WASM imports capture wrapper functions that delegate to these.
 */
type MutableHandlers = {
  log: (level: number, ptr: number, len: number) => void;
  sha1hex: (...args: number[]) => bigint | void;
  call: (...args: number[]) => bigint | void;
  pcall: (...args: number[]) => bigint | void;
};

/**
 * Loaded WASM module that can create engine instances.
 *
 * This class holds a loaded WASM module and provides factory methods
 * to create `LuaEngine` instances. It can only be used once - after
 * calling `create()` or `createStandalone()`, subsequent calls will throw.
 *
 * @example
 * ```typescript
 * const module = await load({ limits: { maxFuel: 1_000_000 } });
 *
 * // Create with Redis host
 * const engine = module.create(myRedisHost);
 *
 * // OR create standalone (no redis.call support)
 * const standalone = module.createStandalone();
 * ```
 */
export class LuaWasmModule {
  private consumed = false;

  /**
   * @internal
   */
  constructor(
    private exports: WasmExports,
    private handlers: MutableHandlers,
    private options: LoadOptions,
  ) {}

  /**
   * Creates an engine with full Redis host integration.
   *
   * This binds the host callbacks to the WASM module. The host provides
   * implementations for `redis.call()`, `redis.pcall()`, and `redis.log()`.
   *
   * This method can only be called once per module instance.
   *
   * @param host - Redis host implementation
   * @returns Configured LuaEngine instance
   * @throws Error if module has already been used
   *
   * @example
   * ```typescript
   * const engine = module.create({
   *   redisCall(args) {
   *     const cmd = args[0].toString().toUpperCase();
   *     if (cmd === "PING") return { ok: Buffer.from("PONG") };
   *     throw new Error("ERR unknown command");
   *   },
   *   redisPcall(args) {
   *     try { return this.redisCall(args); }
   *     catch (e) { return { err: Buffer.from(e.message) }; }
   *   },
   *   log(level, msg) { console.log(msg.toString()); }
   * });
   * ```
   */
  create(host: RedisHost): LuaEngine {
    this.ensureNotConsumed();
    this.consumed = true;

    this.wireHostCallbacks(host);
    this.initializeLua();

    return new LuaEngine(this.exports, this.options.limits);
  }

  /**
   * Creates a standalone engine without Redis host integration.
   *
   * In standalone mode, `redis.call()` and `redis.pcall()` return errors.
   * This is useful for running pure Lua computations or testing.
   *
   * This method can only be called once per module instance.
   *
   * @returns Configured LuaEngine instance
   * @throws Error if module has already been used
   *
   * @example
   * ```typescript
   * const engine = module.createStandalone();
   *
   * engine.eval("return math.sqrt(16)");  // Returns: 4
   * engine.eval("redis.call('PING')");    // Returns: {err: "ERR..."}
   * ```
   */
  createStandalone(): LuaEngine {
    this.ensureNotConsumed();
    this.consumed = true;

    this.wireStandaloneCallbacks();
    this.initializeLua();

    return new LuaEngine(this.exports, this.options.limits);
  }

  /**
   * Returns the default path to the bundled WASM binary.
   */
  static defaultWasmPath(): string {
    return defaultWasmPath();
  }

  /**
   * Returns the default path to the bundled Emscripten JS module.
   */
  static defaultModulePath(): string {
    return defaultModulePath();
  }

  private ensureNotConsumed(): void {
    if (this.consumed) {
      throw new Error(
        "LuaWasmModule has already been used. Load a new module with load().",
      );
    }
  }

  private initializeLua(): void {
    if (this.exports._set_limits && this.options.limits) {
      this.exports._set_limits(
        this.options.limits.maxFuel ?? 0,
        this.options.limits.maxReplyBytes ?? 0,
        this.options.limits.maxArgBytes ?? 0,
      );
    }

    const initResult = this.exports._init();
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
  }

  private wireHostCallbacks(host: RedisHost): void {
    const exports = this.exports;

    const callHandler = (args: Buffer[], isPcall: boolean): ReplyValue => {
      try {
        return isPcall
          ? host.redisPcall.call(host, args)
          : host.redisCall.call(host, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { err: Buffer.from(message, "utf8") };
      }
    };

    this.handlers.log = (level: number, ptr: number, len: number): void => {
      const msg = readBytes(exports.HEAPU8, ptr, len);
      host.log(level, msg);
    };

    this.handlers.sha1hex = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const data = readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len);
      const bytes = computeSha1Hex(data);
      const ptrLen = { ptr: allocAndWrite(exports, bytes), len: bytes.length };
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    this.handlers.call = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const decoded = decodeArgs(
        readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len),
      );
      const ptrLen = encodeReplyToPtrLen(exports, callHandler(decoded, false));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    this.handlers.pcall = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const decoded = decodeArgs(
        readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len),
      );
      const ptrLen = encodeReplyToPtrLen(exports, callHandler(decoded, true));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };
  }

  private wireStandaloneCallbacks(): void {
    const exports = this.exports;

    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(
        `ERR ${action} is not available in standalone mode`,
        "utf8",
      ),
    });

    this.handlers.log = (): void => {};

    this.handlers.sha1hex = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const data = readBytes(exports.HEAPU8, abiArgs.ptr, abiArgs.len);
      const bytes = computeSha1Hex(data);
      const ptrLen = { ptr: allocAndWrite(exports, bytes), len: bytes.length };
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    this.handlers.call = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const ptrLen = encodeReplyToPtrLen(exports, notSupported("redis.call"));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };

    this.handlers.pcall = (...args: number[]): bigint | void => {
      const abiArgs = parseAbiArgs(args);
      const ptrLen = encodeReplyToPtrLen(exports, notSupported("redis.pcall"));
      return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
    };
  }
}

/**
 * Loads the WASM module and returns a LuaWasmModule for creating engines.
 *
 * This is the main entry point for the package. It handles async WASM loading
 * and returns a module that can be used to create engine instances synchronously.
 *
 * @param options - Optional configuration for paths and limits
 * @returns Promise resolving to a LuaWasmModule
 *
 * @example
 * ```typescript
 * // Basic usage
 * const module = await load();
 * const engine = module.create(myRedisHost);
 *
 * // With options
 * const module = await load({
 *   limits: { maxFuel: 10_000_000 },
 *   wasmPath: "/custom/path/to/redis_lua.wasm"
 * });
 * ```
 */
export async function load(options: LoadOptions = {}): Promise<LuaWasmModule> {
  // Mutable handlers - these will be set by wireHostCallbacks/wireStandaloneCallbacks
  const handlers: MutableHandlers = {
    log: () => {},
    sha1hex: () => BigInt(0),
    call: () => BigInt(0),
    pcall: () => BigInt(0),
  };

  // Create wrapper imports that delegate to mutable handlers
  // These wrappers are captured by WASM at instantiation, but they call handlers which can be swapped
  const hostImports: Record<string, HostImport> = {
    host_redis_log: (level: number, ptr: number, len: number) =>
      handlers.log(level, ptr, len),
    host_sha1hex: (...args: number[]) => handlers.sha1hex(...args),
    host_redis_call: (...args: number[]) => handlers.call(...args),
    host_redis_pcall: (...args: number[]) => handlers.pcall(...args),
  };

  const { exports } = await loadModule(options, hostImports);

  return new LuaWasmModule(exports, handlers, options);
}

/**
 * This class provides a convenience API
 * where `create()` and `createStandalone()` are static async methods.
 *
 * @example
 * ```typescript
 * // Convenience API
 * const engine = await LuaWasmEngine.create({ host: myHost });
 *
 * // Modular API
 * const module = await load();
 * const engine = module.create(myHost);
 * ```
 */
export class LuaWasmEngine {
  private constructor(private engine: LuaEngine) {}

  static async create(options: EngineOptions): Promise<LuaWasmEngine> {
    const module = await load(options);
    const engine = module.create(options.host);
    return new LuaWasmEngine(engine);
  }

  static async createStandalone(
    options: StandaloneOptions = {},
  ): Promise<LuaWasmEngine> {
    const module = await load(options);
    const engine = module.createStandalone();
    return new LuaWasmEngine(engine);
  }

  static defaultWasmPath(): string {
    return defaultWasmPath();
  }

  static defaultModulePath(): string {
    return defaultModulePath();
  }

  eval(script: Buffer | Uint8Array | string): ReplyValue {
    return this.engine.eval(script);
  }

  evalWithArgs(
    script: Buffer | Uint8Array | string,
    keys: Array<Buffer | Uint8Array | string> = [],
    args: Array<Buffer | Uint8Array | string> = [],
  ): ReplyValue {
    return this.engine.evalWithArgs(script, keys, args);
  }

  getLimits(): EngineLimits | undefined {
    return this.engine.getLimits();
  }
}

export type {
  EngineOptions,
  ReplyValue,
  RedisCallHandler,
  RedisHost,
  RedisLogHandler,
  StandaloneOptions,
  LoadOptions,
};
