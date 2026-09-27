/**
 * @fileoverview Type definitions for the Redis Lua WASM engine.
 *
 * This module defines the core types used throughout the package:
 * - Reply types that match Redis protocol responses
 * - Host interface for implementing redis.call/pcall/log
 * - Configuration options for the engine
 *
 * @module types
 */

/**
 * Redis-compatible reply value type.
 *
 * This type represents all possible return values from Lua scripts and
 * Redis commands, matching the Redis protocol:
 *
 * - `null` - Lua nil / Redis null bulk reply
 * - `number` - Integer within JavaScript safe integer range
 * - `bigint` - Integer outside safe range (uses BigInt)
 * - `boolean` - RESP3 boolean reply
 * - `Buffer` - Bulk string (binary-safe bytes)
 * - `{ ok: Buffer }` - Status reply (Redis +OK style)
 * - `{ err: Buffer; code?: Buffer }` - Error reply (Redis -ERR style). `err` is
 *   the message; `code` is the optional leading error code (e.g. `WRONGTYPE`).
 *   On decode the code is split out of the wire payload; on encode it is
 *   prepended back. When `code` is omitted the message is used verbatim.
 * - `{ double: number }` - RESP3 double reply
 * - `{ big_number: Buffer }` - RESP3 big number reply
 * - `{ verbatim_string: { format: Buffer; string: Buffer } }` - RESP3 verbatim string
 * - `{ map: [ReplyValue, ReplyValue][] }` - RESP3 map reply
 * - `{ set: ReplyValue[] }` - RESP3 set reply
 * - `ReplyValue[]` - Array of nested values
 *
 * @example
 * ```typescript
 * // Integer reply
 * const count: ReplyValue = 42;
 *
 * // Bulk string reply
 * const data: ReplyValue = Buffer.from("hello");
 *
 * // Status reply
 * const ok: ReplyValue = { ok: Buffer.from("OK") };
 *
 * // Error reply
 * const err: ReplyValue = { err: Buffer.from("ERR unknown command") };
 *
 * // Array reply
 * const arr: ReplyValue = [1, Buffer.from("a"), null];
 * ```
 */
/**
 * Machine-readable detail attached to every script-aborting error reply. The
 * engine composes NO user-facing prose; it classifies the error and lets the
 * host pick the wording (which for these is Redis-version-specific).
 *
 * - `line` (1-based script line) and `sha` (the script's SHA1, already computed
 *   by the engine) are always present.
 * - `kind`/`name` are present only for errors the engine itself originates (the
 *   globals protection). `kind` is an opaque machine tag the host maps to wording;
 *   `name` is the variable involved. The reply's `err` carries the bare `kind`.
 *   Known kinds:
 *   - `global-read`: read of a nonexistent global. Redis >= 7.0:
 *     "Script attempted to access nonexistent global variable '<name>'".
 *   - `command-arg-type`: a redis.call/pcall argument was not a string or number
 *     (no `name`). Redis: "Lua redis lib command arguments must be strings or
 *     integers".
 *
 * Note: writing a global has no kind. It is blocked by Lua's native readonly
 * flag (as in real Redis), so the VM itself raises "Attempt to modify a readonly
 * table"; that message passes through in `err` untouched.
 */
export type ReplyErrorMeta = {
  kind?: string;
  name?: string;
  line: number;
  sha: string;
};

export type ReplyValue =
  | null
  | number
  | bigint
  | boolean
  | Buffer
  | { ok: Buffer }
  | { err: Buffer; code?: Buffer; meta?: ReplyErrorMeta }
  | { double: number }
  | { big_number: Buffer }
  | { verbatim_string: { format: Buffer; string: Buffer } }
  | { map: [ReplyValue, ReplyValue][] }
  | { set: ReplyValue[] }
  | ReplyValue[];

/**
 * Handler function for redis.call() invocations from Lua.
 *
 * This function is called when Lua code executes `redis.call(...)`.
 * Arguments arrive as an array of Buffers (binary-safe).
 *
 * To signal an error, throw an Error - it will be converted to an
 * error reply and returned to Lua.
 *
 * @param args - Command arguments as binary-safe Buffers.
 *               First element is the command name (e.g., "GET", "SET").
 * @param ctx - Call-site context (e.g. the calling script line). Always
 *              supplied by the engine; optional so handlers can call each other.
 * @returns Redis-compatible reply value
 * @throws Error to return an error reply to Lua
 *
 * @example
 * ```typescript
 * const handler: RedisCallHandler = (args) => {
 *   const cmd = args[0].toString().toUpperCase();
 *   if (cmd === "PING") return { ok: Buffer.from("PONG") };
 *   if (cmd === "GET") return Buffer.from("value");
 *   throw new Error("ERR unknown command");
 * };
 * ```
 */
export type RedisCallHandler = (args: Buffer[], ctx?: RedisCallContext) => ReplyValue;

/**
 * Call-site context passed to {@link RedisCallHandler}: the caller of
 * `redis.call`/`redis.pcall` (stack level 1, as Redis 6.2's `luaPushError`
 * sees it). Lets a host build Redis 6.2's `<source>: <line>: ` prefix for
 * pcall errors, which it returns as an error table rather than raising.
 */
export type RedisCallContext = {
  /**
   * Chunk source of the caller, raw bytes: `"@user_script"` for the script
   * itself, the chunk string/name for `loadstring` code, `"=[C]"` when called
   * from a C function (e.g. `pcall(redis.pcall, ...)`). Empty when unknown, in
   * which case Redis omits the prefix. Copied lazily from WASM memory on first
   * access, so read it inside the handler: a first read after the handler has
   * returned throws.
   */
  readonly source: Buffer;
  /** Line of the call within `source`; -1 for a C caller, 0 when unknown. */
  line: number;
};

/**
 * Handler function for redis.log() invocations from Lua.
 *
 * This function is called when Lua code executes `redis.log(level, message)`.
 * The message is binary-safe but typically contains UTF-8 text.
 *
 * Redis log levels:
 * - 0 = LOG_DEBUG
 * - 1 = LOG_VERBOSE
 * - 2 = LOG_NOTICE
 * - 3 = LOG_WARNING
 *
 * @param level - Numeric Redis log level
 * @param message - Log message as binary-safe Buffer
 *
 * @example
 * ```typescript
 * const handler: RedisLogHandler = (level, message) => {
 *   const levels = ["DEBUG", "VERBOSE", "NOTICE", "WARNING"];
 *   console.log(`[${levels[level]}] ${message.toString()}`);
 * };
 * ```
 */
export type RedisLogHandler = (level: number, message: Buffer) => void;

/**
 * Host interface that must be implemented to handle Redis commands.
 *
 * This interface defines the callbacks that the Lua runtime uses to
 * interact with the host environment. All three methods must be provided.
 *
 * @example
 * ```typescript
 * const host: RedisHost = {
 *   redisCall(args) {
 *     // Handle redis.call() - may throw on error
 *     const cmd = args[0].toString().toUpperCase();
 *     if (cmd === "PING") return { ok: Buffer.from("PONG") };
 *     throw new Error("ERR unknown command");
 *   },
 *   redisPcall(args, ctx) {
 *     // Handle redis.pcall() - return error instead of throwing
 *     try {
 *       return this.redisCall(args, ctx);
 *     } catch (err) {
 *       return { err: Buffer.from(err.message) };
 *     }
 *   },
 *   log(level, message) {
 *     console.log(`[${level}] ${message.toString()}`);
 *   }
 * };
 * ```
 */
export type RedisHost = {
  /**
   * Handler for redis.call() - throws on error. A throw, or a malformed
   * ReplyValue, is raised in the script as a Lua error carrying its message.
   */
  redisCall: RedisCallHandler;

  /**
   * Handler for redis.pcall() - returns error reply instead of throwing. A
   * throw, or a malformed ReplyValue, is returned to the script as an error
   * reply carrying its message.
   */
  redisPcall: RedisCallHandler;

  /**
   * Handler for redis.log() messages. A throw is raised in the script as a Lua
   * error carrying its message.
   */
  log: RedisLogHandler;

  /**
   * Optional: notified when the script calls `redis.setresp(n)`. The WASM
   * encoder still flips its own RESP mode; this hook lets the host match the
   * reply shapes it returns from `redisCall`/`redisPcall` to the new protocol.
   * A throw rejects the switch and is raised in the script as a Lua error.
   */
  onSetResp?: (version: 2 | 3) => void;
};

/**
 * A single host-injected `redis.*` property.
 *
 * - `{ value }`  -> `redis[name] = value` (a plain field).
 * - `{ returns }` -> `redis[name] = function(...) return <returns> end`. The stub
 *   ignores all arguments. `returns: null` makes it return nothing (a noop, e.g.
 *   `set_repl`).
 */
export type RedisProp =
  | { value: string | number | boolean }
  | { returns: string | number | boolean | null };

/**
 * Map of `redis.*` member name -> prop. Injected onto the `redis` table at engine
 * init, before globals protection locks it. The package ships none of these by
 * default (blank slate); the host supplies what it needs.
 */
export type RedisProps = Record<string, RedisProp>;

/**
 * Resource limits for the Lua engine.
 *
 * These limits protect against runaway scripts and resource exhaustion.
 * All limits are optional - unset (or 0) limits are not enforced. All are
 * enforced by the WASM runtime. Values must be non-negative integers (`load()`
 * throws a RangeError for negative, fractional, non-finite or non-numeric
 * values); values above 2^32 - 1 are capped to it.
 *
 * @example
 * ```typescript
 * const limits: EngineLimits = {
 *   maxFuel: 10_000_000,              // ~10M instructions
 *   maxReplyBytes: 2 * 1024 * 1024,   // 2 MB replies
 *   maxArgBytes: 1 * 1024 * 1024      // 1 MB of KEYS + ARGV
 * };
 * ```
 */
export type EngineLimits = {
  /** Maximum instruction count (fuel) for script execution. */
  maxFuel?: number;

  /**
   * Maximum size in bytes of the encoded script reply (see docs/abi.md). The
   * limit is checked while the reply is encoded, so an oversized reply fails
   * with `ERR reply exceeds configured limit` as soon as it crosses it. Error
   * replies for script errors are not limited.
   */
  maxReplyBytes?: number;

  /**
   * Maximum size in bytes of the encoded KEYS + ARGV array passed to
   * `evalWithArgs` (4 bytes of count, plus 4 bytes of length and the data of
   * each entry). A larger one fails with `ERR KEYS/ARGV exceeds configured
   * limit` without running the script.
   */
  maxArgBytes?: number;
};

/**
 * Named Redis/Valkey compatibility profile. Selects which of the Lua behaviors
 * that differ across versions (see {@link CompatOverrides}) are emulated.
 * Aliases collapse to identical behavior (redis-7.0 == redis-7.2; redis-7.4 == redis-8.0;
 * valkey-8.0 == valkey-9.0). Use {@link CompatOverrides} to tweak a single flag.
 * The profile also selects the version's `redis.log` error wording, which has
 * no override.
 */
export type CompatProfile =
  | "redis-6.2"
  | "redis-7.0"
  | "redis-7.2"
  | "redis-7.4"
  | "redis-8.0"
  | "valkey-8.0"
  | "valkey-9.0";

/**
 * Fine-grained overrides for the compatibility profile, merged over the
 * selected {@link CompatProfile} (or the default). These are the Lua behaviors
 * that differ across Redis 6.2-8.x and Valkey.
 */
export type CompatOverrides = {
  /** Keep the Lua `print` global. Only Redis 6.2 did. Default: false. */
  print?: boolean;
  /** Expose the (sandboxed) `os` library. Redis 7.4+ / Valkey 8.0+. Default: true. */
  os?: boolean;
  /** Expose `server` as an alias of `redis`. Valkey 8.0+ only. Default: true. */
  serverAlias?: boolean;
  /**
   * Reseed `math.random` with 0 before every script, so each script sees the
   * same sequence. Only Redis 6.2 did; Redis 7.0+ and Valkey keep one sequence
   * running across scripts (per engine here, per server process there), and
   * `math.randomseed` changes it for the scripts that follow. Default: false.
   */
  reseedRandom?: boolean;
  /**
   * Redis 7 error model: `redis.call` and the other `redis.*` functions raise
   * errors as `{err=...}` tables, and the global `pcall` returns the `err`
   * string of a caught error table (`xpcall` handlers see the table). Also
   * `redis.error_reply` derives the error code (`'foo'` -> `ERR foo`) and the
   * `redis.log` argument errors carry the `ERR` code. Off, errors are plain
   * strings and `redis.error_reply` returns its argument unchanged, as in
   * Redis 6.2. Redis 7.0+ / Valkey. Default: true.
   */
  tableErrors?: boolean;
};

/**
 * Configuration options for `LuaEngine.create` (an engine with host integration).
 *
 * @example
 * ```typescript
 * const options: EngineOptions = {
 *   host: {
 *     redisCall(args) { ... },
 *     redisPcall(args) { ... },
 *     log(level, msg) { ... }
 *   },
 *   limits: { maxFuel: 10_000_000 }
 * };
 *
 * const engine = await LuaEngine.create(options);
 * ```
 */
export type EngineOptions = {
  /** Required host interface for redis.call/pcall/log. */
  host: RedisHost;

  /**
   * Optional location of the WASM binary file: a filesystem path or `file://`
   * URL in Node, a URL in the browser. Uses the bundled file if not provided.
   * The file is read and compiled once per process; later loads reuse it.
   */
  wasmPath?: string;

  /**
   * Optional pre-loaded WASM binary (e.g. `await response.arrayBuffer()`).
   * Takes precedence over wasmPath. Compiled once per object: pass the same
   * one again to reuse it (do not mutate it).
   */
  wasmBytes?: Uint8Array | ArrayBuffer;

  /** Optional path to the Emscripten JS module. Uses bundled module if not provided. */
  modulePath?: string;

  /** Optional resource limits. */
  limits?: EngineLimits;

  /** Optional host-injected `redis.*` props (constants and simple stubs). */
  redisProps?: RedisProps;

  /**
   * Redis/Valkey version whose Lua sandbox behavior to emulate. Default:
   * ≈ valkey-8.0, except that the `redis.log` arity error names `redis.log()`
   * (Redis wording) instead of `server.log()`.
   */
  profile?: CompatProfile;

  /** Per-flag compatibility overrides, merged over `profile` (or the default). */
  compat?: CompatOverrides;
};

/**
 * Configuration options for `LuaEngine.createStandalone`.
 *
 * Standalone mode runs without redis.call/pcall support - those
 * functions will return errors if called. Useful for pure Lua computations.
 *
 * @example
 * ```typescript
 * const engine = await LuaEngine.createStandalone({
 *   limits: { maxFuel: 1_000_000 }
 * });
 *
 * engine.eval("return math.sqrt(16)");  // Works
 * engine.eval("redis.call('PING')");    // Returns error
 * ```
 */
export type StandaloneOptions = {
  /**
   * Optional location of the WASM binary file: a filesystem path or `file://`
   * URL in Node, a URL in the browser. Uses the bundled file if not provided.
   * The file is read and compiled once per process; later loads reuse it.
   */
  wasmPath?: string;

  /**
   * Optional pre-loaded WASM binary (e.g. `await response.arrayBuffer()`).
   * Takes precedence over wasmPath. Compiled once per object: pass the same
   * one again to reuse it (do not mutate it).
   */
  wasmBytes?: Uint8Array | ArrayBuffer;

  /** Optional path to the Emscripten JS module. */
  modulePath?: string;

  /** Optional resource limits. */
  limits?: EngineLimits;

  /** Optional host-injected `redis.*` props (constants and simple stubs). */
  redisProps?: RedisProps;

  /**
   * Redis/Valkey version whose Lua sandbox behavior to emulate. Default:
   * ≈ valkey-8.0, except that the `redis.log` arity error names `redis.log()`
   * (Redis wording) instead of `server.log()`.
   */
  profile?: CompatProfile;

  /** Per-flag compatibility overrides, merged over `profile` (or the default). */
  compat?: CompatOverrides;
};

/**
 * Configuration options for loading the WASM module.
 *
 * These options control how the WASM binary is located and loaded.
 * The returned LuaWasmModule can then be used to create engine instances.
 *
 * @example
 * ```typescript
 * const module = await load({
 *   limits: { maxFuel: 1_000_000 }
 * });
 *
 * const engine = module.create(myRedisHost);
 * ```
 */
export type LoadOptions = {
  /**
   * Optional location of the WASM binary file: a filesystem path or `file://`
   * URL in Node, a URL in the browser. Uses the bundled file if not provided.
   * The file is read and compiled once per process; later loads reuse it.
   */
  wasmPath?: string;

  /**
   * Optional pre-loaded WASM binary (e.g. `await response.arrayBuffer()`).
   * Takes precedence over wasmPath. Compiled once per object: pass the same
   * one again to reuse it (do not mutate it).
   */
  wasmBytes?: Uint8Array | ArrayBuffer;

  /** Optional path to the Emscripten JS module. */
  modulePath?: string;

  /** Optional resource limits applied to all engines created from this module. */
  limits?: EngineLimits;

  /** Optional host-injected `redis.*` props (constants and simple stubs). */
  redisProps?: RedisProps;

  /**
   * Redis/Valkey version whose Lua sandbox behavior to emulate. Default:
   * ≈ valkey-8.0, except that the `redis.log` arity error names `redis.log()`
   * (Redis wording) instead of `server.log()`.
   */
  profile?: CompatProfile;

  /** Per-flag compatibility overrides, merged over `profile` (or the default). */
  compat?: CompatOverrides;
};
