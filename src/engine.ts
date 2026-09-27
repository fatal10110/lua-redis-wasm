/**
 * @fileoverview Main API for executing Redis Lua scripts in WebAssembly.
 *
 * This module provides the primary API for the redis-lua-wasm package:
 * - `load()` - Async function to load the WASM module
 * - `LuaWasmModule` - Factory for creating engine instances
 * - `LuaEngine` - Executes Lua scripts; `LuaEngine.create()` /
 *   `LuaEngine.createStandalone()` combine load and create
 * - `LuaWasmEngine` - Deprecated alias of `LuaEngine`
 *
 * ## Architecture
 *
 * The API separates async loading from sync execution. The compiled WASM
 * module is cached, so every `load()` after the first only instantiates it:
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
 * │  - reset() (fresh Lua VM), dispose() (release the instance) │
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
  failureErrorReply,
  REPLY_SCRIPT_ERROR,
  SCRIPT_ERROR_ENGINE,
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
 * with `LuaEngine.create()` / `LuaEngine.createStandalone()`, or from a
 * `LuaWasmModule` returned by `load()`.
 *
 * Each engine owns its own WASM instance (and linear memory); the compiled
 * WASM module is shared. Call `dispose()` when done with an engine.
 *
 * ## Evaluating Scripts
 *
 * ```typescript
 * const engine = await LuaEngine.createStandalone();
 *
 * // Simple evaluation
 * engine.eval("return 1 + 1");  // Returns: 2
 *
 * // With KEYS and ARGV
 * engine.evalWithArgs(
 *   "return {KEYS[1], ARGV[1]}",
 *   [Buffer.from("key")],
 *   [Buffer.from("arg")]
 * );
 *
 * engine.dispose();
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

  /** Set by dispose(); `instance` and `handlers` are then dropped. */
  private disposed = false;

  /**
   * Evaluations in progress. Non-zero while a script runs, i.e. whenever a
   * host callback of this engine is executing (a nested eval, which the
   * runtime refuses, counts too).
   */
  private activeEvals = 0;

  private instance: WasmExports | null;
  private handlers: MutableHandlers | null;

  /**
   * @internal
   */
  constructor(
    exports: WasmExports,
    private limits: EngineLimits | undefined,
    handlers: MutableHandlers,
  ) {
    this.instance = exports;
    this.handlers = handlers;
  }

  /**
   * Loads the WASM module and creates an engine with full Redis host
   * integration: `load(options)` followed by `create(options.host)`.
   *
   * @example
   * ```typescript
   * const engine = await LuaEngine.create({
   *   host: myRedisHost,
   *   limits: { maxFuel: 10_000_000 },
   * });
   * ```
   */
  static async create(options: EngineOptions): Promise<LuaEngine> {
    const module = await load(options);
    return module.create(options.host);
  }

  /**
   * Loads the WASM module and creates a standalone engine (no
   * redis.call/pcall): `load(options)` followed by `createStandalone()`.
   *
   * @example
   * ```typescript
   * const engine = await LuaEngine.createStandalone();
   * engine.eval("return math.sqrt(16)");  // 4
   * ```
   */
  static async createStandalone(
    options: StandaloneOptions = {},
  ): Promise<LuaEngine> {
    const module = await load(options);
    return module.createStandalone();
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

  /**
   * Replaces the Lua VM with a fresh one, as if the engine had just been
   * created: whatever earlier scripts left in the VM (e.g. `cjson` settings)
   * is discarded. The limits, compat profile, `redisProps` and host callbacks
   * are kept, and so is the `math.random` generator state (process-wide in
   * Redis too; see docs/compat.md).
   *
   * @throws Error if a script is running (i.e. when called from one of this
   *   engine's host callbacks), after dispose(), or if the engine is unusable
   * @throws Error if the new VM could not be built (out of memory, or the
   *   `redisProps` could not be applied); until a later reset() succeeds,
   *   every eval returns an `ERR Lua VM not initialized` error reply
   */
  reset(): void {
    this.assertUsable();
    this.assertIdle("reset");
    const exports = this.exports;
    const handlers = this.handlers!;
    handlers.propsFault = undefined;
    let rc: number;
    try {
      rc = exports._reset();
    } catch (err) {
      this.markFaulted(err);
      throw err;
    }
    // Written by the props import during _reset (TS keeps the narrowing above).
    const propsFault = handlers.propsFault as MutableHandlers["propsFault"];
    if (propsFault) {
      handlers.propsFault = undefined;
      if (propsFault.error instanceof WasmFault) {
        this.markFaulted(propsFault.error);
      } else {
        // The VM was built without the props; leave none rather than that one.
        exports._close_vm?.();
      }
      throw propsFault.error;
    }
    if (rc !== 0) {
      throw new Error(
        "Failed to reset the Lua VM; every eval returns an error until reset() succeeds",
      );
    }
  }

  /**
   * Releases the engine: closes the Lua VM and drops this engine's references
   * to its WASM instance (with its linear memory) and to the host callbacks,
   * so they can be garbage collected. Afterwards eval, evalWithArgs and reset
   * throw. Calling it again does nothing.
   *
   * @throws Error if a script is running (i.e. when called from one of this
   *   engine's host callbacks); the engine is left untouched, so dispose it
   *   after the evaluation returns
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.assertIdle("dispose");
    const exports = this.instance;
    // After a fault the module is not trusted: just drop it.
    if (exports && !this.faulted) {
      try {
        exports._close_vm?.();
      } catch {
        // The instance is dropped either way.
      }
    }
    this.disposed = true;
    this.instance = null;
    if (this.handlers) {
      // The WASM imports keep the handlers object; detach the host from it.
      Object.assign(this.handlers, idleHandlers());
      this.handlers = null;
    }
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
   * @throws RangeError if the WASM heap cannot hold the script (the engine
   *   stays usable)
   * @throws Error if an exception escaped the WASM module, now or in a
   *   previous call; the engine is then unusable
   * @throws Error if the engine has been disposed
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
   * @throws Error if the engine has been disposed
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
      this.activeEvals++;
      try {
        invoke(retPtr);
      } catch (err) {
        this.markFaulted(err);
        throw err;
      } finally {
        this.activeEvals--;
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
   * The WASM exports. Every public entry point checks assertUsable() first,
   * so this never sees a disposed engine.
   * @private
   */
  private get exports(): WasmExports {
    if (!this.instance) {
      throw new Error(DISPOSED_MESSAGE);
    }
    return this.instance;
  }

  /**
   * @private
   */
  private assertIdle(action: "reset" | "dispose"): void {
    if (this.activeEvals > 0) {
      throw new Error(
        `LuaEngine.${action}() cannot be called while a script is running (from a host callback); call it after the evaluation returns`,
      );
    }
  }

  /**
   * @private
   */
  private assertUsable(): void {
    if (this.disposed) {
      throw new Error(DISPOSED_MESSAGE);
    }
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
 * - Engine-originated errors (globals protection, a bad redis.call argument)
 *   are flagged by the WASM runtime (`SCRIPT_ERROR_ENGINE`), which sends their
 *   kind and name in fields of their own (`value.engine`); we forward
 *   `{ kind, name }` in `meta` and the host chooses the wording. `err` carries
 *   the bare `kind` as a machine-readable default. The message text alone never
 *   makes an engine error (#59), and the kind is never read from it (#87).
 * - Lua runtime / redis.call errors already carry their own message (and code);
 *   they pass through untouched, with only `line`/`sha` attached for the host to
 *   decorate. A table error's `err` (`SCRIPT_ERROR_FROM_TABLE`, Redis 7 error
 *   model) is what Redis sends as-is (`-<err>`), so it has a `code` only if its
 *   first word is one (#76); any other error has code `ERR` and its whole
 *   message as `err`, as Redis prefixes `ERR ` (#83). The codec applies this.
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
  value: {
    err: Buffer;
    code?: Buffer;
    line?: number;
    flags?: number;
    engine?: { kind: string; name?: string };
  },
  script: Buffer,
): { err: Buffer; code?: Buffer; meta: ReplyErrorMeta } {
  const sha = computeSha1Hex(script).toString("utf8");
  const flags = value.flags ?? 0;
  let line = value.line ?? 1;
  if (value.line === undefined) {
    const errStr = value.err.toString("utf8");
    if (errStr.startsWith("user_script:")) {
      const colonIdx = errStr.indexOf(":", 12); // after "user_script:"
      if (colonIdx > 12) {
        line = Number(errStr.substring(12, colonIdx)) || 1;
      }
    }
  }

  if (flags & SCRIPT_ERROR_ENGINE && value.engine) {
    const { kind, name } = value.engine;
    return {
      err: Buffer.from(kind, "utf8"),
      code: Buffer.from("ERR", "utf8"),
      meta: name === undefined ? { kind, line, sha } : { kind, name, line, sha },
    };
  }

  // The codec already applied the code rule (a table error keeps a propagated
  // code such as WRONGTYPE, or none; any other error has ERR).
  return value.code === undefined
    ? { err: value.err, meta: { line, sha } }
    : { err: value.err, code: value.code, meta: { line, sha } };
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
 * (pcall). A thrown exception is a host failure, not a reply the host built,
 * so it gets the generic `ERR` code when its message has none (a returned
 * `{ err }` is passed on as is). If even that cannot be allocated, the zero
 * PtrLen makes C raise "ERR empty reply from host".
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
      out = encodeReplyToPtrLen(
        exports,
        failureErrorReply(Buffer.from(errorMessage(err), "utf8")),
      );
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
  /**
   * Set when the props import failed during `_init` / `_reset`; rethrown by
   * create() / reset().
   */
  propsFault?: { error: unknown };
};

/** Handlers with no host attached: before create() and after dispose(). */
function idleHandlers(): Omit<MutableHandlers, "propsFault"> {
  return {
    log: () => {},
    setresp: () => {},
    call: () => null,
    pcall: () => null,
    props: () => {},
  };
}

const DISPOSED_MESSAGE = "LuaEngine has been disposed; create a new engine";

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
const COMPAT_TABLE_ERRORS = 0x10;
const COMPAT_LOG_DEBUG_LEVEL = 0x20;
const COMPAT_VALKEY_WORDING = 0x40;

/**
 * Profile presets -> the Lua behavior flags. Mirrors the
 * Redis/Valkey version matrix (see redis-version-lua-behavior-matrix).
 */
const COMPAT_PROFILES: Record<CompatProfile, Required<CompatOverrides>> = {
  "redis-6.2": { print: true, os: false, serverAlias: false, reseedRandom: true, tableErrors: false },
  "redis-7.0": { print: false, os: false, serverAlias: false, reseedRandom: false, tableErrors: true },
  "redis-7.2": { print: false, os: false, serverAlias: false, reseedRandom: false, tableErrors: true },
  "redis-7.4": { print: false, os: true, serverAlias: false, reseedRandom: false, tableErrors: true },
  "redis-8.0": { print: false, os: true, serverAlias: false, reseedRandom: false, tableErrors: true },
  "valkey-8.0": { print: false, os: true, serverAlias: true, reseedRandom: false, tableErrors: true },
  "valkey-9.0": { print: false, os: true, serverAlias: true, reseedRandom: false, tableErrors: true },
};

// Default when no profile is given: preserve the historical behavior (≈ valkey-8.0).
const COMPAT_DEFAULT: Required<CompatOverrides> = COMPAT_PROFILES["valkey-8.0"];

/**
 * Error wording that differs by version but is no behavior of its own, so it
 * follows the profile only (no override): `redis.log` says "Invalid debug
 * level." up to Redis 7.2, and Valkey names `server.log()` in its arity error
 * and says "Command arguments must be ..." for a bad `redis.call` /
 * `redis.pcall` argument. No profile keeps the historical Redis 7.4+ wording.
 * Only these bits are profile-only: the Redis 6.2 forms (e.g. the bad-argument
 * "@user_script: <line>: Lua redis() ..." text) follow `compat.tableErrors`,
 * so the override changes them.
 */
const COMPAT_PROFILE_WORDING: Record<CompatProfile, number> = {
  "redis-6.2": COMPAT_LOG_DEBUG_LEVEL,
  "redis-7.0": COMPAT_LOG_DEBUG_LEVEL,
  "redis-7.2": COMPAT_LOG_DEBUG_LEVEL,
  "redis-7.4": 0,
  "redis-8.0": 0,
  "valkey-8.0": COMPAT_VALKEY_WORDING,
  "valkey-9.0": COMPAT_VALKEY_WORDING,
};

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
    (merged.reseedRandom ? COMPAT_RESEED_RANDOM : 0) |
    (merged.tableErrors ? COMPAT_TABLE_ERRORS : 0) |
    (profile ? COMPAT_PROFILE_WORDING[profile] : 0)
  );
}

const LIMIT_NAMES = ["maxFuel", "maxReplyBytes", "maxArgBytes"] as const;
const U32_MAX = 0xffff_ffff;

/**
 * Rejects limit values the WASM runtime cannot represent: every limit is a
 * non-negative integer count of instructions or bytes (0 = not set). A
 * fraction is rejected rather than rounded, so a value in (0, 1) can never
 * turn into 0, i.e. no limit.
 */
function validateLimits(limits: EngineLimits | undefined): void {
  if (!limits) {
    return;
  }
  for (const name of LIMIT_NAMES) {
    const value = limits[name];
    if (value !== undefined && !(Number.isInteger(value) && value >= 0)) {
      throw new RangeError(
        `limits.${name} must be a non-negative integer, got ${String(value)}`,
      );
    }
  }
}

/**
 * A validated limit as the u32 `set_limits` takes; values beyond u32
 * saturate instead of wrapping.
 */
function toU32Limit(value: number | undefined): number {
  return value === undefined ? 0 : Math.min(value, U32_MAX);
}

export class LuaWasmModule {
  /** Dropped once consumed: from then on only the engine holds them. */
  private exports: WasmExports | null;
  private handlers: MutableHandlers | null;

  /**
   * @internal
   */
  constructor(
    exports: WasmExports,
    handlers: MutableHandlers,
    private options: LoadOptions,
  ) {
    this.exports = exports;
    this.handlers = handlers;
  }

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
    const { exports, handlers } = this.consume();

    this.wireHostCallbacks(exports, handlers, host);
    this.initializeLua(exports, handlers);

    return new LuaEngine(exports, this.options.limits, handlers);
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
    const { exports, handlers } = this.consume();

    this.wireStandaloneCallbacks(handlers);
    this.initializeLua(exports, handlers);

    return new LuaEngine(exports, this.options.limits, handlers);
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

  /**
   * Marks the module used and hands its instance over to the engine being
   * created.
   */
  private consume(): { exports: WasmExports; handlers: MutableHandlers } {
    if (!this.exports || !this.handlers) {
      throw new Error(
        "LuaWasmModule has already been used. Load a new module with load().",
      );
    }
    const taken = { exports: this.exports, handlers: this.handlers };
    this.exports = null;
    this.handlers = null;
    return taken;
  }

  private initializeLua(exports: WasmExports, handlers: MutableHandlers): void {
    const limits = this.options.limits;
    if (exports._set_limits && limits) {
      exports._set_limits(
        toU32Limit(limits.maxFuel),
        toU32Limit(limits.maxReplyBytes),
        toU32Limit(limits.maxArgBytes),
      );
    }

    if (exports._set_compat) {
      exports._set_compat(
        resolveCompatFlags(this.options.profile, this.options.compat),
      );
    }

    const initResult = exports._init();
    const propsFault = handlers.propsFault;
    if (propsFault) {
      throw propsFault.error;
    }
    if (typeof initResult === "number" && initResult !== 0) {
      throw new Error("Failed to initialize Lua WASM engine");
    }
  }

  private wireHostCallbacks(
    exports: WasmExports,
    handlers: MutableHandlers,
    host: RedisHost,
  ): void {
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

    handlers.log = (level: number, message: Buffer): void => {
      host.log(level, message);
    };

    handlers.setresp = (version: number): void => {
      host.onSetResp?.call(host, version as 2 | 3);
    };

    handlers.call = (args: Buffer[]): ReplyValue => callHandler(args, false);
    handlers.pcall = (args: Buffer[]): ReplyValue => callHandler(args, true);
  }

  private wireStandaloneCallbacks(handlers: MutableHandlers): void {
    const notSupported = (action: string): ReplyValue => ({
      err: Buffer.from(
        `ERR ${action} is not available in standalone mode`,
        "utf8",
      ),
    });

    handlers.log = (): void => {};
    handlers.call = (): ReplyValue => notSupported("redis.call");
    handlers.pcall = (): ReplyValue => notSupported("redis.pcall");
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
  const handlers: MutableHandlers = idleHandlers();

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
 * @deprecated Use `LuaEngine.create()` / `LuaEngine.createStandalone()`.
 * `LuaWasmEngine` is now an alias of `LuaEngine` (same statics, instances are
 * `LuaEngine`s) and will be removed in a future major version.
 *
 * @example
 * ```typescript
 * // Before
 * const engine = await LuaWasmEngine.create({ host: myHost });
 * // After
 * const engine = await LuaEngine.create({ host: myHost });
 * ```
 */
export const LuaWasmEngine = LuaEngine;
/**
 * @deprecated Use `LuaEngine`. Will be removed in a future major version.
 */
export type LuaWasmEngine = LuaEngine;

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
