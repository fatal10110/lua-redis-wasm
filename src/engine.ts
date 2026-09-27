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
  ReplyErrorMeta,
  RedisHost,
  RedisCallHandler,
  RedisCallContext,
  RedisLogHandler,
  EngineOptions,
  StandaloneOptions,
  RedisProp,
  RedisProps,
  CompatProfile,
  CompatOverrides,
} from "./types.js";
import {
  decodeReply,
  encodeArgArray,
  encodeRedisProps,
  ensureBuffer,
  REPLY_SCRIPT_ERROR,
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
  alloc,
  allocAndWrite,
  encodeReplyToPtrLen,
  writePtrLen,
  readPtrLen,
  decodeArgs,
  computeSha1Hex,
  WasmFault,
  type PtrLen,
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
   * Set when an exception escaped the WASM module (mid-evaluation, or from
   * `_alloc`). The unwind skipped the C cleanup (Lua call frames, error
   * handlers, the shadow stack, allocator bookkeeping), so the module can no
   * longer be trusted and every later call is refused.
   */
  private fault: unknown = undefined;
  private faulted = false;

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
   * @throws RangeError if the WASM heap cannot hold the script (the engine
   *   stays usable)
   * @throws Error if an exception escaped the WASM module, now or in a
   *   previous call; the engine is then unusable
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
    this.assertUsable();
    const scriptBuf = ensureBuffer(script, "script");
    const scriptPtr = this.write(scriptBuf);
    try {
      return this.run(scriptBuf, (retPtr) =>
        this.exports._eval(retPtr, scriptPtr, scriptBuf.length),
      );
    } finally {
      this.release(scriptPtr);
    }
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
   * @throws RangeError if the WASM heap cannot hold the script or KEYS/ARGV
   *   (the engine stays usable)
   * @throws Error if an exception escaped the WASM module, now or in a
   *   previous call; the engine is then unusable
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
    this.assertUsable();
    const scriptBuf = ensureBuffer(script, "script");
    // maxArgBytes is enforced by the WASM runtime (run_script).
    const argBuf = encodeArgArray([...keys, ...args]);

    const scriptPtr = this.write(scriptBuf);
    try {
      const argsPtr = this.write(argBuf);
      try {
        return this.run(scriptBuf, (retPtr) =>
          this.exports._eval_with_args(
            retPtr,
            scriptPtr,
            scriptBuf.length,
            argsPtr,
            argBuf.length,
            keys.length,
          ),
        );
      } finally {
        this.release(argsPtr);
      }
    } finally {
      this.release(scriptPtr);
    }
  }

  /**
   * Runs one WASM evaluation export. PtrLen-returning exports take a hidden
   * struct-return pointer as their first argument (clang's wasm32 C ABI), so
   * `invoke` receives an 8-byte scratch slot to pass through.
   *
   * Host imports only throw a WasmFault (see `load()`), so an exception here
   * means the WASM frames were unwound past their C cleanup: the engine is
   * marked unusable before the exception is rethrown.
   *
   * `script` is only read to compute the SHA1 of a script-aborting error.
   * @private
   */
  private run(script: Buffer, invoke: (retPtr: number) => void): ReplyValue {
    const retPtr = this.guardAlloc(() => alloc(this.exports, 8));
    let result: PtrLen;
    try {
      try {
        invoke(retPtr);
      } catch (err) {
        this.markFaulted(err);
        throw err;
      }
      result = readPtrLen(this.exports.HEAPU8, retPtr);
    } finally {
      this.release(retPtr);
    }
    return this.decodeResult(result, script);
  }

  /**
   * Copies `data` into a fresh WASM allocation.
   * @throws RangeError if the heap cannot hold it (the engine stays usable)
   * @throws WasmFault if `_alloc` threw (the engine becomes unusable)
   * @private
   */
  private write(data: Buffer): number {
    return this.guardAlloc(() => allocAndWrite(this.exports, data));
  }

  /**
   * @private
   */
  private guardAlloc(allocate: () => number): number {
    try {
      return allocate();
    } catch (err) {
      if (err instanceof WasmFault) {
        this.markFaulted(err);
      }
      throw err;
    }
  }

  /**
   * @private
   */
  private markFaulted(err: unknown): void {
    this.faulted = true;
    this.fault = err;
  }

  /**
   * Frees a buffer passed to WASM. After a fault the heap is abandoned along
   * with the VM, so nothing is freed (the allocator state is not trusted).
   * @private
   */
  private release(ptr: number): void {
    if (!this.faulted) {
      this.exports._free_mem(ptr);
    }
  }

  /**
   * @private
   */
  private assertUsable(): void {
    if (this.faulted) {
      const reason =
        this.fault instanceof Error ? this.fault.message : String(this.fault);
      throw new Error(
        `LuaEngine is unusable: a previous evaluation was aborted by an exception; create a new engine. Cause: ${reason}`,
        { cause: this.fault },
      );
    }
  }

  /**
   * Decodes a PtrLen result from WASM into a ReplyValue. maxReplyBytes is
   * enforced by the WASM runtime while it encodes the reply.
   * @private
   */
  private decodeResult({ ptr, len }: PtrLen, script: Buffer): ReplyValue {
    if (!ptr || !len) {
      return null;
    }

    const buffer = readBytes(this.exports.HEAPU8, ptr, len);
    this.exports._free_mem(ptr);
    const topTag = len > 0 ? buffer.readUInt8(0) : -1;
    const value = decodeReply(buffer).value;

    // Decorate only errors that aborted the script (REPLY_SCRIPT_ERROR): an
    // uncaught Lua runtime error or an error that propagated out of redis.call.
    // Error values the script returns (REPLY_ERROR, e.g. `return redis.pcall`)
    // are passed through untouched, matching Redis.
    if (
      topTag === REPLY_SCRIPT_ERROR &&
      value &&
      typeof value === "object" &&
      "err" in value
    ) {
      return buildScriptError(value, script);
    }

    return value;
  }
}

/**
 * Builds a script-aborting error reply. The engine composes no user-facing prose:
 *
 * - Engine-originated errors (globals protection) arrive as a coded marker; we
 *   forward `{ kind, name }` in `meta` and the host chooses the wording. `err`
 *   carries the bare `kind` as a machine-readable default.
 * - Lua runtime / redis.call errors already carry their own message (and code);
 *   they pass through untouched, with only `line`/`sha` attached for the host to
 *   decorate.
 *
 * The line comes from the WASM error handler (`value.line`), which captures the
 * script frame at the error point — including command errors propagated out of
 * redis.call, which carry no `user_script:N:` text prefix. When the handler did
 * not run (load/syntax errors), `value.line` is absent and the line is parsed
 * from the message's `user_script:N:` prefix, defaulting to 1.
 *
 * The script's SHA1 is computed here, for script errors only, rather than on
 * every evaluation.
 */
function buildScriptError(
  value: { err: Buffer; code?: Buffer; line?: number },
  script: Buffer,
): { err: Buffer; code: Buffer; meta: ReplyErrorMeta } {
  const sha = computeSha1Hex(script).toString("utf8");
  const errStr = value.err.toString("utf8");
  let line = value.line ?? 1;
  if (value.line === undefined && errStr.startsWith("user_script:")) {
    const colonIdx = errStr.indexOf(":", 12); // after "user_script:"
    if (colonIdx > 12) {
      line = Number(errStr.substring(12, colonIdx)) || 1;
    }
  }

  const marker = parseErrorMarker(errStr);
  if (marker) {
    return {
      err: Buffer.from(marker.kind, "utf8"),
      code: Buffer.from("ERR", "utf8"),
      meta: { kind: marker.kind, name: marker.name, line, sha },
    };
  }

  return {
    err: value.err,
    // Preserve a propagated command code (e.g. WRONGTYPE); otherwise "ERR".
    code: value.code ?? Buffer.from("ERR", "utf8"),
    meta: { line, sha },
  };
}

/**
 * Builds the `host_redis_props` handler. The import takes only the struct-return
 * pointer and writes the encoded redisProps blob's PtrLen there. A `count == 0`
 * blob (length 4) is treated as "no props" and yields a zero PtrLen so C skips
 * application.
 *
 * @internal exported for testing.
 */
export function makePropsHandler(
  exports: WasmExports,
  blob: Buffer,
): (retPtr: number) => void {
  const empty = blob.length <= 4; // only the u32 count, zero entries
  return (retPtr: number): void => {
    const ptrLen = empty
      ? NULL_PTR_LEN
      : { ptr: allocAndWrite(exports, blob), len: blob.length };
    writePtrLen(exports.HEAPU8, retPtr, ptrLen);
  };
}

// =============================================================================
// Host import guards
// =============================================================================
//
// A JS exception must never unwind out of a host import: it would tear through
// the WASM frames of the running lua_pcall, skipping every C cleanup and leaving
// the Lua VM corrupted. Each import therefore catches everything and reports the
// failure through its return value, which C turns into an ordinary Lua error.
// The one exception is a WasmFault (a throwing `_alloc`): the module is already
// untrusted, so it propagates and the running eval marks the engine unusable.

/** Rethrows a WasmFault; every other error is for the caller to report. */
function rethrowFault(err: unknown): void {
  if (err instanceof WasmFault) {
    throw err;
  }
}

const NULL_PTR_LEN: PtrLen = { ptr: 0, len: 0 };

/** The message of a thrown value, without letting a hostile value throw again. */
function errorMessage(err: unknown): string {
  try {
    return err instanceof Error ? String(err.message) : String(err);
  } catch {
    return "host callback threw";
  }
}

/**
 * Completes a redis.call/redis.pcall import by writing the encoded reply to
 * `retPtr`. A throw anywhere (argument decoding, the host handler, encoding a
 * malformed ReplyValue, heap exhaustion) becomes an error reply carrying the
 * exception message, which C raises (call) or returns as an error table
 * (pcall). If even that cannot be allocated, the zero PtrLen makes C raise
 * "ERR empty reply from host".
 */
function writeReplyImport(
  exports: WasmExports,
  retPtr: number,
  produce: () => ReplyValue,
): void {
  let out: PtrLen;
  try {
    out = encodeReplyToPtrLen(exports, produce());
  } catch (err) {
    rethrowFault(err);
    try {
      out = encodeReplyToPtrLen(exports, {
        err: Buffer.from(errorMessage(err), "utf8"),
      });
    } catch (fallbackErr) {
      rethrowFault(fallbackErr);
      out = NULL_PTR_LEN;
    }
  }
  writePtrLen(exports.HEAPU8, retPtr, out);
}

/**
 * Completes a void host import (redis.log, redis.setresp): a zero PtrLen on
 * success; on failure `len != 0` with `ptr` holding the exception message (or 0
 * when it could not be allocated), which C raises as a Lua error (see abi.h).
 */
function writeStatusImport(
  exports: WasmExports,
  retPtr: number,
  run: () => void,
): void {
  let out = NULL_PTR_LEN;
  try {
    run();
  } catch (err) {
    rethrowFault(err);
    out = { ptr: 0, len: 1 };
    try {
      const message = Buffer.from(errorMessage(err), "utf8");
      if (message.length > 0) {
        out = { ptr: allocAndWrite(exports, message), len: message.length };
      }
    } catch (fallbackErr) {
      // Keep the message-less failure; C substitutes a generic one.
      rethrowFault(fallbackErr);
    }
  }
  writePtrLen(exports.HEAPU8, retPtr, out);
}

/**
 * Completes the redis.sha1hex import. On failure (heap exhaustion) the zero
 * PtrLen makes C raise "ERR sha1hex failed".
 */
function writeSha1Import(
  exports: WasmExports,
  retPtr: number,
  ptr: number,
  len: number,
): void {
  let out = NULL_PTR_LEN;
  try {
    const digest = computeSha1Hex(readBytes(exports.HEAPU8, ptr, len));
    out = { ptr: allocAndWrite(exports, digest), len: digest.length };
  } catch (err) {
    rethrowFault(err);
    // Otherwise report the zero PtrLen.
  }
  writePtrLen(exports.HEAPU8, retPtr, out);
}

const ERROR_MARKER = "__RLUA_E__:";

/**
 * Engine-originated errors (globals protection, see runtime.c) cross the
 * Lua->WASM->JS boundary as a coded string `__RLUA_E__:<kind>:<name>` (Lua errors
 * carry no type tag, so the discriminator travels in the string). Splits out the
 * opaque `kind` and `name`; the library forwards them and never interprets the
 * kind. Returns undefined for ordinary error messages.
 */
function parseErrorMarker(
  errStr: string,
): { kind: string; name?: string } | undefined {
  const idx = errStr.indexOf(ERROR_MARKER);
  if (idx < 0) {
    return undefined;
  }
  const rest = errStr.slice(idx + ERROR_MARKER.length); // "<kind>" or "<kind>:<name>"
  const sep = rest.indexOf(":");
  return sep < 0
    ? { kind: rest }
    : { kind: rest.slice(0, sep), name: rest.slice(sep + 1) };
}

/**
 * Mutable handlers that can be swapped after WASM instantiation. The WASM
 * imports built in `load()` own the memory marshalling and exception
 * containment and delegate the host-facing work to these, which may throw.
 */
type MutableHandlers = {
  log: (level: number, message: Buffer) => void;
  setresp: (version: number) => void;
  call: (args: Buffer[]) => ReplyValue;
  pcall: (args: Buffer[]) => ReplyValue;
  props: (retPtr: number) => void;
  /** Set when the props import failed during `_init`; rethrown by create(). */
  propsFault?: { error: unknown };
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
// Compatibility flag bits — must match the COMPAT_* macros in wasm/src/runtime.c.
const COMPAT_PRINT = 0x1;
const COMPAT_OS = 0x2;
const COMPAT_SERVER_ALIAS = 0x4;
const COMPAT_RESEED_RANDOM = 0x8;

/**
 * Profile presets -> the four Lua sandbox behavior flags. Mirrors the
 * Redis/Valkey version matrix (see redis-version-lua-behavior-matrix).
 */
const COMPAT_PROFILES: Record<CompatProfile, Required<CompatOverrides>> = {
  "redis-6.2": { print: true, os: false, serverAlias: false, reseedRandom: true },
  "redis-7.0": { print: false, os: false, serverAlias: false, reseedRandom: false },
  "redis-7.2": { print: false, os: false, serverAlias: false, reseedRandom: false },
  "redis-7.4": { print: false, os: true, serverAlias: false, reseedRandom: false },
  "redis-8.0": { print: false, os: true, serverAlias: false, reseedRandom: false },
  "valkey-8.0": { print: false, os: true, serverAlias: true, reseedRandom: false },
  "valkey-9.0": { print: false, os: true, serverAlias: true, reseedRandom: false },
};

// Default when no profile is given: preserve the historical behavior (≈ valkey-8.0).
const COMPAT_DEFAULT: Required<CompatOverrides> = COMPAT_PROFILES["valkey-8.0"];

/** Resolve a profile + per-flag overrides to the u8 bitmask the WASM expects. */
function resolveCompatFlags(
  profile?: CompatProfile,
  overrides?: CompatOverrides,
): number {
  const merged = {
    ...(profile ? COMPAT_PROFILES[profile] : COMPAT_DEFAULT),
    ...overrides,
  };
  return (
    (merged.print ? COMPAT_PRINT : 0) |
    (merged.os ? COMPAT_OS : 0) |
    (merged.serverAlias ? COMPAT_SERVER_ALIAS : 0) |
    (merged.reseedRandom ? COMPAT_RESEED_RANDOM : 0)
  );
}

const LIMIT_NAMES = ["maxFuel", "maxMemoryBytes", "maxReplyBytes", "maxArgBytes"] as const;
const U32_MAX = 0xffff_ffff;

/**
 * Rejects limit values the WASM runtime cannot represent: every limit is a
 * non-negative number of instructions or bytes (0 = not set).
 */
function validateLimits(limits: EngineLimits | undefined): void {
  if (!limits) {
    return;
  }
  for (const name of LIMIT_NAMES) {
    const value = limits[name];
    if (value !== undefined && (typeof value !== "number" || !(value >= 0))) {
      throw new RangeError(
        `limits.${name} must be a non-negative number, got ${String(value)}`,
      );
    }
  }
}

/**
 * A validated limit as the u32 `set_limits` takes. Fractions are truncated and
 * values beyond u32 (including Infinity) saturate instead of wrapping.
 */
function toU32Limit(value: number | undefined): number {
  return value === undefined ? 0 : Math.min(Math.floor(value), U32_MAX);
}

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
   *   redisPcall(args, ctx) {
   *     try { return this.redisCall(args, ctx); }
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
    const limits = this.options.limits;
    if (this.exports._set_limits && limits) {
      this.exports._set_limits(
        toU32Limit(limits.maxFuel),
        toU32Limit(limits.maxReplyBytes),
        toU32Limit(limits.maxArgBytes),
        toU32Limit(limits.maxMemoryBytes),
      );
    }

    if (this.exports._set_compat) {
      this.exports._set_compat(
        resolveCompatFlags(this.options.profile, this.options.compat),
      );
    }

    const initResult = this.exports._init();
    const propsFault = this.handlers.propsFault;
    if (propsFault) {
      throw propsFault.error;
    }
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
  }

  private wireHostCallbacks(host: RedisHost): void {
    const exports = this.exports;

    const callHandler = (args: Buffer[], isPcall: boolean): ReplyValue => {
      // source is copied lazily: for loadstring code it is the whole chunk, and
      // most handlers never read it. The pointer is only valid during the
      // handler, so a first read after it returns throws instead of reading
      // memory the chunk may no longer own.
      const sourcePtr = exports._current_call_source?.() ?? 0;
      let source: Buffer | undefined;
      let done = false;
      const ctx: RedisCallContext = {
        line: exports._current_call_line?.() ?? 0,
        get source() {
          if (source === undefined && done) {
            throw new Error("ctx.source read after the redis.call handler returned");
          }
          const heap = exports.HEAPU8;
          return (source ??= sourcePtr
            ? readBytes(heap, sourcePtr, heap.indexOf(0, sourcePtr) - sourcePtr)
            : Buffer.alloc(0));
        },
      };
      // A throw becomes an error reply in the import guard (writeReplyImport).
      try {
        return isPcall
          ? host.redisPcall.call(host, args, ctx)
          : host.redisCall.call(host, args, ctx);
      } finally {
        done = true;
      }
    };

    this.handlers.log = (level: number, message: Buffer): void => {
      host.log(level, message);
    };

    this.handlers.setresp = (version: number): void => {
      host.onSetResp?.call(host, version as 2 | 3);
    };

    this.handlers.call = (args: Buffer[]): ReplyValue => callHandler(args, false);
    this.handlers.pcall = (args: Buffer[]): ReplyValue => callHandler(args, true);
  }

  private wireStandaloneCallbacks(): void {
    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(
        `ERR ${action} is not available in standalone mode`,
        "utf8",
      ),
    });

    this.handlers.log = (): void => {};
    this.handlers.call = (): ReplyValue => notSupported("redis.call");
    this.handlers.pcall = (): ReplyValue => notSupported("redis.pcall");
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
  validateLimits(options.limits);

  // Mutable handlers - these will be set by wireHostCallbacks/wireStandaloneCallbacks
  const handlers: MutableHandlers = {
    log: () => {},
    setresp: () => {},
    call: () => null,
    pcall: () => null,
    props: () => {},
  };

  // Assigned once instantiated; WASM only calls the imports after that.
  let exports: WasmExports;

  // Imports captured by WASM at instantiation. They delegate to the swappable
  // handlers and never throw (see "Host import guards"). Every PtrLen-returning
  // import receives the struct-return pointer as its first argument.
  const hostImports: Record<string, HostImport> = {
    host_redis_log: (retPtr: number, level: number, ptr: number, len: number) =>
      writeStatusImport(exports, retPtr, () =>
        handlers.log(level, readBytes(exports.HEAPU8, ptr, len)),
      ),
    host_redis_setresp: (retPtr: number, version: number) =>
      writeStatusImport(exports, retPtr, () => handlers.setresp(version)),
    host_sha1hex: (retPtr: number, ptr: number, len: number) =>
      writeSha1Import(exports, retPtr, ptr, len),
    host_redis_call: (retPtr: number, ptr: number, len: number) =>
      writeReplyImport(exports, retPtr, () =>
        handlers.call(decodeArgs(readBytes(exports.HEAPU8, ptr, len))),
      ),
    host_redis_pcall: (retPtr: number, ptr: number, len: number) =>
      writeReplyImport(exports, retPtr, () =>
        handlers.pcall(decodeArgs(readBytes(exports.HEAPU8, ptr, len))),
      ),
    host_redis_props: (retPtr: number) => {
      try {
        handlers.props(retPtr);
      } catch (error) {
        handlers.propsFault ??= { error };
        writePtrLen(exports.HEAPU8, retPtr, NULL_PTR_LEN);
      }
    },
  };

  ({ exports } = await loadModule(options, hostImports));

  // Wire the props handler now that we have real exports + the encoded blob.
  handlers.props = makePropsHandler(exports, encodeRedisProps(options.redisProps));

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
  RedisProp,
  RedisProps,
  CompatProfile,
  CompatOverrides,
};
