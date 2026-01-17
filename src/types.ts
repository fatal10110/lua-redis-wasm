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
 * - `Buffer` - Bulk string (binary-safe bytes)
 * - `{ ok: Buffer }` - Status reply (Redis +OK style)
 * - `{ err: Buffer }` - Error reply (Redis -ERR style)
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
export type ReplyValue =
  | null
  | number
  | bigint
  | Buffer
  | { ok: Buffer }
  | { err: Buffer }
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
export type RedisCallHandler = (args: Buffer[]) => ReplyValue;

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
 *   redisPcall(args) {
 *     // Handle redis.pcall() - return error instead of throwing
 *     try {
 *       return this.redisCall(args);
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
  /** Handler for redis.call() - throws on error. */
  redisCall: RedisCallHandler;

  /** Handler for redis.pcall() - returns error reply instead of throwing. */
  redisPcall: RedisCallHandler;

  /** Handler for redis.log() messages. */
  log: RedisLogHandler;
};

/**
 * Resource limits for the Lua engine.
 *
 * These limits protect against runaway scripts and resource exhaustion.
 * All limits are optional - unset limits are not enforced.
 *
 * @example
 * ```typescript
 * const limits: EngineLimits = {
 *   maxFuel: 10_000_000,           // ~10M instructions
 *   maxMemoryBytes: 64 * 1024 * 1024, // 64 MB
 *   maxReplyBytes: 2 * 1024 * 1024,   // 2 MB replies
 *   maxArgBytes: 1 * 1024 * 1024      // 1 MB per argument
 * };
 * ```
 */
export type EngineLimits = {
  /** Maximum instruction count (fuel) for script execution. Enforced by WASM runtime. */
  maxFuel?: number;

  /** Maximum memory bytes. Soft limit coordinated with host. */
  maxMemoryBytes?: number;

  /** Maximum reply payload size in bytes. Enforced by WASM runtime. */
  maxReplyBytes?: number;

  /** Maximum argument size in bytes. Enforced by host before passing to WASM. */
  maxArgBytes?: number;
};

/**
 * Configuration options for creating a LuaWasmEngine with host integration.
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
 * const engine = await LuaWasmEngine.create(options);
 * ```
 */
export type EngineOptions = {
  /** Required host interface for redis.call/pcall/log. */
  host: RedisHost;

  /** Optional path to the WASM binary file. Uses bundled file if not provided. */
  wasmPath?: string;

  /** Optional pre-loaded WASM binary. Takes precedence over wasmPath. */
  wasmBytes?: Uint8Array;

  /** Optional path to the Emscripten JS module. Uses bundled module if not provided. */
  modulePath?: string;

  /** Optional resource limits. */
  limits?: EngineLimits;
};

/**
 * Configuration options for creating a standalone LuaWasmEngine.
 *
 * Standalone mode runs without redis.call/pcall support - those
 * functions will return errors if called. Useful for pure Lua computations.
 *
 * @example
 * ```typescript
 * const engine = await LuaWasmEngine.createStandalone({
 *   limits: { maxFuel: 1_000_000 }
 * });
 *
 * engine.eval("return math.sqrt(16)");  // Works
 * engine.eval("redis.call('PING')");    // Returns error
 * ```
 */
export type StandaloneOptions = {
  /** Optional path to the WASM binary file. */
  wasmPath?: string;

  /** Optional pre-loaded WASM binary. */
  wasmBytes?: Uint8Array;

  /** Optional path to the Emscripten JS module. */
  modulePath?: string;

  /** Optional resource limits. */
  limits?: EngineLimits;
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
  /** Optional path to the WASM binary file. */
  wasmPath?: string;

  /** Optional pre-loaded WASM binary. */
  wasmBytes?: Uint8Array;

  /** Optional path to the Emscripten JS module. */
  modulePath?: string;

  /** Optional resource limits applied to all engines created from this module. */
  limits?: EngineLimits;
};
