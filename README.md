# lua-redis-wasm

[![npm version](https://img.shields.io/npm/v/lua-redis-wasm.svg)](https://www.npmjs.com/package/lua-redis-wasm)
[![CI](https://github.com/fatal10110/lua-redis-wasm/workflows/ci/badge.svg)](https://github.com/fatal10110/lua-redis-wasm/actions)
[![Node.js Version](https://img.shields.io/node/v/lua-redis-wasm.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A WebAssembly-based Redis Lua 5.1 script engine for Node.js. Execute Redis-compatible Lua scripts in JavaScript/TypeScript environments without a live Redis server.

> **Primary purpose:** this engine powers the Lua scripting (`EVAL`/`EVALSHA`)
> support in [js-redis-server](https://github.com/fatal10110/js-redis-server), an
> in-memory Redis-compatible server. It is published as a standalone package so
> it can be reused, but its API and error semantics are driven by what
> js-redis-server needs to match real Redis. If you embed it directly, expect it
> to behave the way Redis behaves inside that server.

## Features

- **Redis-compatible Lua 5.1** - Uses the exact Lua version embedded in Redis
- **Binary-safe** - Full support for null bytes in scripts, arguments, and return values
- **Host integration** - Implement `redis.call`, `redis.pcall`, and `redis.log` in JavaScript
- **Resource limits** - Fuel-based instruction limiting, reply size caps, and memory coordination
- **Redis standard libraries** - Includes `cjson`, `cmsgpack`, `struct`, and `bit` modules
- **TypeScript support** - Full type definitions included

## Installation

```bash
npm install lua-redis-wasm
```

**Requirements:** Node.js >= 22

## Quick Start

```typescript
import { LuaEngine } from "lua-redis-wasm";

const engine = await LuaEngine.create({
  host: {
    redisCall(args) {
      const cmd = args[0].toString();
      if (cmd === "PING") return { ok: Buffer.from("PONG") };
      if (cmd === "GET") return Buffer.from("value");
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args, ctx) {
      return this.redisCall(args, ctx);
    },
    log(level, message) {
      console.log(`[${level}] ${message.toString()}`);
    },
  },
});

// Simple evaluation
const result = engine.eval("return 1 + 1"); // Returns: 2

// With KEYS and ARGV
const data = engine.evalWithArgs(
  "return {KEYS[1], ARGV[1]}",
  [Buffer.from("user:1")],
  [Buffer.from("hello")],
);

// Release the engine's WASM instance when done
engine.dispose();
```

## API

### LuaEngine.create(options)

Creates a new engine instance with host integration.

```typescript
const engine = await LuaEngine.create({
  host: RedisHost,         // Required: host callbacks
  limits?: EngineLimits,   // Optional: resource limits
  wasmPath?: string,       // Optional: custom WASM file path (Node: path or file:// URL)
  wasmBytes?: Uint8Array | ArrayBuffer, // Optional: pre-loaded WASM binary
  redisProps?: RedisProps, // Optional: host-injected redis.* constants/stubs
});
```

### LuaEngine.createStandalone(options)

Creates an engine without host integration. `redis.call` and `redis.pcall` return errors.

```typescript
const engine = await LuaEngine.createStandalone({});
engine.eval("return math.sqrt(16)"); // Works
engine.eval("return redis.call('PING')"); // Returns error
```

### Injecting `redis.*` props

The package ships no version-specific `redis.*` helpers by default. Supply them via `redisProps`:

```typescript
const engine = await LuaEngine.create({
  host,
  redisProps: {
    REDIS_VERSION:      { value: "7.4.0" },
    REPL_ALL:           { value: 3 },
    replicate_commands: { returns: true },  // function(...) return true end
    set_repl:           { returns: null },  // function(...) end (noop)
  },
});
```

`{ value }` sets a constant field; `{ returns }` sets a stub function that ignores
its arguments and returns the given constant (`null` returns nothing). `server` is
an internal alias of `redis` — both reference the same table with the same injected
props, with or without `redisProps` set. Numeric values follow Redis's number semantics — a Lua number returned from a script is truncated to an integer (e.g. a non-integer numeric prop reads back truncated).

### engine.eval(script)

Evaluates a Lua script and returns the result.

```typescript
engine.eval("return 'hello'"); // Returns: Buffer.from("hello")
engine.eval("return {1, 2, 3}"); // Returns: [1, 2, 3]
```

### engine.evalWithArgs(script, keys, args)

Evaluates a script with binary-safe `KEYS` and `ARGV` arrays.

```typescript
engine.evalWithArgs(
  "return {KEYS[1], ARGV[1], ARGV[2]}",
  [Buffer.from("key:1")],
  [Buffer.from("arg1"), Buffer.from("arg2\x00with-null")],
);
```

### engine.reset()

Replaces the Lua VM with a fresh one, as if the engine had just been created:
whatever earlier scripts left in the VM (e.g. `cjson.encode_max_depth(...)`
settings) is discarded. Limits, `profile`/`compat`, `redisProps` and the host
callbacks are kept, and so is the `math.random` generator state (process-wide in
Redis too, see [docs/compat.md](docs/compat.md)).

```typescript
engine.reset();
```

`reset()` throws when called while a script is running (i.e. from one of the
engine's host callbacks), after `dispose()`, or on an unusable engine. If the new
VM cannot be built (out of memory) it throws and every `eval` returns
`ERR Lua VM not initialized` until a later `reset()` succeeds.

### engine.dispose()

Closes the Lua VM and drops the engine's WASM instance (with its 64 MB linear
memory) and host callbacks so they can be garbage collected. Afterwards `eval`,
`evalWithArgs` and `reset` throw `LuaEngine has been disposed`; calling `dispose()`
again does nothing. It throws when called while a script is running (from one of
the engine's host callbacks) and leaves the engine untouched; dispose it once the
evaluation has returned.

```typescript
const engine = await LuaEngine.createStandalone();
try {
  engine.eval(script);
} finally {
  engine.dispose();
}
```

### load(options) and LuaWasmModule

`LuaEngine.create(options)` is `load(options)` followed by
`module.create(options.host)` (and `createStandalone` by
`module.createStandalone()`). Use the two steps to separate the async load from
the synchronous engine creation:

```typescript
import { load } from "lua-redis-wasm";

const module = await load({ limits: { maxFuel: 10_000_000 } });
const engine = module.create(myHost); // or module.createStandalone()
```

A `LuaWasmModule` creates exactly one engine. The compiled WASM module is cached
for the process (keyed by the resolved `wasmPath`/URL, or by the `wasmBytes`
object), so only the first `load()` reads and compiles the binary; every engine
still gets its own instance and memory, and engines share no state.

### LuaWasmEngine (deprecated)

`LuaWasmEngine` is a deprecated alias of `LuaEngine`, kept until the next major
version: `LuaWasmEngine.create(...)` / `LuaWasmEngine.createStandalone(...)` still
work and return a `LuaEngine`. Replace `LuaWasmEngine` with `LuaEngine`.

## Host Interface

The host must implement three callbacks:

```typescript
type RedisHost = {
  redisCall: (args: Buffer[], ctx?: RedisCallContext) => ReplyValue; // For redis.call()
  redisPcall: (args: Buffer[], ctx?: RedisCallContext) => ReplyValue; // For redis.pcall()
  log: (level: number, message: Buffer) => void; // For redis.log()
};
```

### redisCall

Called when Lua executes `redis.call(...)`. Arguments arrive as `Buffer[]`. Return a
`ReplyValue`, or signal an error by returning `{ err, code? }` (or throwing).

Number arguments are formatted like Redis 7.4+ (`luaArgsToRedisArgv`), not with
Lua's lossy `%.14g`: integral values up to 2^62 in magnitude as plain integers
(`1e15` → `1000000000000000`, `-0.0` → `0`), everything else in the shortest
round-trip form (`0.1+0.2` → `0.30000000000000004`, `1e300` → `1e+300`, `1/0` →
`inf`, `0/0` → `nan` or `-nan`). This applies whatever the `profile` compat
option. Older versions differ: Redis 7.2.0–7.2.4 always used the shortest form
(`1e15` → `1e+15`; 7.2.5+ matches 7.4), and Redis 7.0 and earlier used `%.17g`
(`3.3` → `3.2999999999999998`).

A zero-argument `redis.call()` / `redis.pcall()` is delegated to the host with an
empty `args` array — the host decides the error — rather than being short-circuited
by the engine.

### redisPcall

Called when Lua executes `redis.pcall(...)`. Return `{ err: Buffer, code?: Buffer }`
instead of throwing to match Redis behavior.

### Host callback failures

A host callback never breaks the engine. A throw from `redisCall`, or a malformed
`ReplyValue` it returns (e.g. `{ map: "x" }`, a non-Buffer `ok`, or a reply nested
too deeply to encode), becomes an error reply carrying the exception message,
with the generic `ERR` code when the message does not start with an uppercase
code (`throw new Error("oops")` → `ERR oops`, like Redis's `addReplyError`; a
returned `{ err }` reply is passed on as is): `redis.call` raises it,
`redis.pcall` returns it as an error table. A throw from
`log` or `onSetResp` is raised in the script as an ordinary Lua error with the
exception message (a script can catch it with `pcall`); this differs from Redis,
where `redis.log` cannot fail. A throwing `onSetResp` also leaves the protocol
unchanged.

If an exception still escapes the WASM module, the VM can no longer be trusted:
that call throws, and every later `eval` / `evalWithArgs` throws
`LuaEngine is unusable: ...` (with the original error as `cause`). Create a new
engine to continue. This covers a WASM trap or abort (e.g. `cmsgpack.pack`
running out of heap aborts, as in Redis) and a throwing `_alloc`, which is
reported as the exported `WasmFault` error class:

```typescript
import { WasmFault } from "lua-redis-wasm";

try {
  engine.eval(script);
} catch (err) {
  if (err instanceof RangeError) {
    // The script or KEYS/ARGV did not fit in the WASM heap; the engine is fine.
  } else if (err instanceof WasmFault) {
    // _alloc threw inside the module: the engine is now unusable, recreate it.
  } else {
    // A WASM trap/abort, or "LuaEngine is unusable" from an earlier fault:
    // recreate the engine too.
  }
}
```

### Call context

Both handlers receive `ctx: { source, line }`, the caller of `redis.call`/`redis.pcall`
exactly as Redis 6.2's `luaPushError` sees it (stack level 1): `source` (a `Buffer`,
read it inside the handler) is
`"@user_script"` for the script, the chunk for `loadstring` code, or `"=[C]"` (line
`-1`) for a C caller such as `pcall(redis.pcall, ...)`. `source` is empty when unknown.
Use it to emit Redis 6.2's pcall error prefix, keeping `source` as bytes (a template
literal would UTF-8-decode it):

```typescript
const prefixed = Buffer.concat([ctx.source, Buffer.from(`: ${ctx.line}: `), message]);
```

Read `ctx.source` inside the handler; a first read after the handler has returned
throws. When delegating between handlers, pass `ctx` along
(`this.redisCall(args, ctx)`).

A handler must not evaluate another script on the same engine: while a script is
running, `eval` / `evalWithArgs` reply
`ERR nested eval is not supported: a script is already running` (Redis likewise
refuses `EVAL` from inside a script).

### Error metadata

The engine composes **no** user-facing error wording — it classifies the error and
lets the host render. When a script aborts, the reply carries:

- `code` — the RESP error class (e.g. `WRONGTYPE`); preserved from `redis.call`.
  An uncaught string error always has code `ERR` and its whole message as `err`,
  whatever its first word (`error('MY boom', 0)` → code `ERR`, `err` `MY boom`),
  as Redis sends it as `-ERR <message>`. One leading `ERR ` is dropped, because
  the engine's own string errors carry it, so `error('ERR x', 0)` reports `x`
  (Redis: `-ERR ERR x`). In the Redis 7 error model (every profile but `redis-6.2`, see
  `compat.tableErrors`), an error table's `err` is what Redis sends as-is, so a
  table error has a `code` only when its `err` starts with one:
  `error({err='MY boom'})` → code `MY`, `err` `boom`; `error({err='boom'})` → no
  `code`, `err` `boom` (Redis: `-boom script: ...`). With `redis-6.2` string
  errors, which Redis 6.2 always sends as `-ERR ...`, every script error takes
  the string rule: `error({err='MY boom'})` → code `ERR`, `err` `MY boom`. Write
  `-<code> <err>`, or `-<err>` when `code` is absent.
  See [Reply Types](#reply-types).
- `meta` — `{ line, sha }` always, plus `{ kind, name }` for errors the engine itself
  classifies (`global-read` of a nonexistent global; `command-arg-type` for a bad
  `redis.call` argument). `kind` is an opaque machine tag the host maps to wording;
  `name` is the variable involved, raw (it may contain CR/LF). The engine flags
  these errors itself; error text a script or a host command error produces never
  gets a `kind`, whatever it contains. Writing a global has no `kind`: it is blocked by
  Lua's native readonly flag (as in real Redis), which recursively locks the whole
  globals tree, so the VM itself raises "Attempt to modify a readonly table".
- `err` — for engine-originated errors, the bare `kind` (a machine default). For Lua
  runtime / `redis.call` errors, the original message, passed through untouched.
  An error object that is a table (`error({err='MY custom'})`,
  `error(redis.error_reply('boom'))`, a `redis.call` error) is reported by its `err`
  field, like Redis 7.0+ (`ERR unknown error` when `err` is not a string); other
  non-string values as Lua's `tostring` renders them (`error(nil)` → `nil`). This
  applies to every profile, `redis-6.2` included, although Redis 6.2 itself fails
  on a table error (its error handler concatenates it as a string).

The host owns wording: map `kind` to the Redis message (version-specific if you care)
and decorate with `line`/`sha` as needed
(`<message> script: <sha>, on @user_script:<line>.`). An error **value** the script
returns (e.g. `return redis.pcall(...)`) is passed through untouched.

Hosts should return plain, undecorated error messages.

### Error objects inside the script

By default, and with every `profile` except `redis-6.2`, scripts see the Redis 7.0+
error model: `redis.call` (and `redis.log`, `redis.setresp`, ...) raise an `{err=...}`
table, and the global `pcall` returns the `err` string of a caught error table, so
`pcall(redis.call, ...)` still yields a string while an `xpcall` handler receives the
table. A host command error becomes the same table `redis.pcall` returns:
`{err='CODE message', ignore_error_stats_update=true}`, with the generic `ERR` code
added to a message that has no space and trailing CR/LF trimmed, as in Redis. With
`profile: "redis-6.2"` errors are plain strings and a host error reaches the script
verbatim; the `redis.log` and `redis.setresp` argument errors carry no `ERR` code
(`RESP version must be 2 or 3.`), and `redis.error_reply` returns its argument
unchanged, as in Redis 6.2. The `compat.tableErrors` option overrides the
profile. When the error aborts the script, the host receives what each Redis
version sends. In the table model a host error reply (or `error({err=...})`
table) keeps its code (`WRONGTYPE ...` → code `WRONGTYPE`), stays code-less when
its first word is not an uppercase code (`"oops something"`), as Redis 7 sends it
as-is, and has CR/LF around the message after the code trimmed (`"\r\nboom"` →
`boom`). With string errors every script error has code `ERR` and the whole
message, less one leading `ERR ` (`WRONGTYPE ...` → code `ERR`, `err`
`WRONGTYPE ...`; `RESP version must be 2 or 3.` → code `ERR`; `"\r\nboom"` →
`"  boom"`), as Redis 6.2 replies `-ERR Error running script ...`.

### log

Called when Lua executes `redis.log(level, ...)`. Level is a numeric Redis log level
(`redis.LOG_DEBUG`..`redis.LOG_WARNING`), truncated to an integer, which must be
0..3. As in Redis, every argument after the level is joined with a space into
`message`. Arguments `lua_tolstring` cannot convert (nil, booleans, tables) are
skipped and get no separator of their own. Errors raised (default wording):

- fewer than two arguments: `ERR redis.log() requires two arguments or more.`
- a level that is not a number: `ERR First argument must be a number (log level).`
- a level outside 0..3: `ERR Invalid log level.`

The handler receives every message, and filtering by verbosity is up to the host.

The wording follows the `profile` compat option, as in each version's source:

| profile | arity error | level error | `ERR` code |
|---|---|---|---|
| `redis-6.2` | `redis.log() requires ...` | `Invalid debug level.` | no |
| `redis-7.0`, `redis-7.2` | `redis.log() requires ...` | `Invalid debug level.` | yes |
| `redis-7.4`, `redis-8.0`, no profile | `redis.log() requires ...` | `Invalid log level.` | yes |
| `valkey-8.0`, `valkey-9.0` | `server.log() requires ...` | `Invalid log level.` | yes |

The `ERR` code came with the Redis 7 error model, so it follows
`compat.tableErrors` (see [Error objects inside the script](#error-objects-inside-the-script));
the wording itself follows the profile only.

## Reply Types

Return values are Redis-compatible:

```typescript
type ReplyValue =
  | null // Lua nil
  | number // Integer (safe range)
  | bigint // Integer (64-bit)
  | boolean // RESP3 boolean
  | Buffer // Bulk string
  | { ok: Buffer } // Status reply (+OK)
  | { err: Buffer; code?: Buffer; meta?: ReplyErrorMeta } // Error reply (-ERR); code e.g. WRONGTYPE, meta for rendering
  | { double: number } // RESP3 double
  | { big_number: Buffer } // RESP3 big number
  | { verbatim_string: { format: Buffer; string: Buffer } } // RESP3 verbatim string
  | { map: [ReplyValue, ReplyValue][] } // RESP3 map
  | { set: ReplyValue[] } // RESP3 set
  | ReplyValue[]; // Array
```

The ABI supports RESP2 replies and RESP3 booleans, doubles, maps, sets, big
numbers, and verbatim strings. Typed tables (`{double=}`, `{big_number=}`,
`{map=}`, `{set=}`, `{verbatim_string=}`) in a script's return value convert at
any protocol level, like real Redis. `redis.setresp(3)` only changes how
booleans and `redis.call` replies are converted for the current script.

Hosts serving RESP2 clients must therefore convert typed replies themselves,
even when `onSetResp(3)` was never called. Real Redis sends a RESP2 client a
bulk string for `double`, `big_number` and `verbatim_string`, a flat
key/value array for `map`, and a plain array for `set`.

On decode, an error payload of the form `CODE message` is split into `err` (the
message) and `code` (the leading `[A-Z][A-Z0-9]*` token, when present). On encode the
`code` is prepended back, so the wire form is always Redis's `CODE message`.

`redis.error_reply(msg)` follows Redis 7.0+: one leading `-` is dropped. With no space,
`ERR ` is prepended (`'foo'` → `ERR foo`). Otherwise the message is kept and its first
token is the code, whatever its case (`'My Error'` stays `My Error`, `'-ERR x'` → `ERR x`).
On decode, a token that is not uppercase, like `My`, stays in `err` with no `code`.
The wire bytes are the same either way. Any call but one string argument returns
`{err='ERR wrong number or type of arguments'}`.

With `profile: "redis-6.2"` (or `compat.tableErrors: false`) it follows Redis 6.2
instead: the string is returned unchanged (`'foo'` → `{err='foo'}`, `'-ERR x'` →
`{err='-ERR x'}`), and a bad call returns
`{err='@user_script: <line>: wrong number or type of arguments'}` with no code.

### Determining the Response Type

Use type guards to inspect what Lua returned:

```typescript
const result = engine.eval(script);

// Check for null (Lua nil)
if (result === null) {
  console.log("Got nil");
}

// Check for integer
else if (typeof result === "number" || typeof result === "bigint") {
  console.log("Got integer:", result);
}

// Check for array (Lua table with sequential keys)
else if (Array.isArray(result)) {
  console.log("Got array with", result.length, "elements");
  for (const item of result) {
    // Each element is also a ReplyValue - handle recursively
  }
}

// Check for status reply ({ok: Buffer}) - e.g. from SET, PING
else if (typeof result === "object" && "ok" in result) {
  console.log("Got status:", result.ok.toString());
}

// Check for error reply ({err: Buffer})
else if (typeof result === "object" && "err" in result) {
  console.log("Got error:", result.err.toString());
}

// Otherwise it's a bulk string (Buffer)
else if (Buffer.isBuffer(result)) {
  console.log("Got bulk string:", result.toString());
}
```

### Lua Type Conversions

This matches Redis Lua behavior:

```typescript
// Lua nil → null
engine.eval("return nil"); // null

// Lua number → number (or bigint for large values)
engine.eval("return 42"); // 42
engine.eval("return 2^62"); // 4611686018427387904n (bigint)

// Lua string → Buffer
engine.eval("return 'hello'"); // Buffer.from("hello")

// Lua table (array) → ReplyValue[]
engine.eval("return {1, 2, 3}"); // [1, 2, 3]
engine.eval("return {'a', 'b'}"); // [Buffer, Buffer]

// Values with no reply type (functions, coroutines, userdata such as
// cjson.null) → null, at any depth
engine.eval("return function() end"); // null
engine.eval("return {1, function() end, 3}"); // [1, null, 3]

// Status reply: commands like SET, PING return {ok: "..."}
// In Lua: local resp = redis.call('SET', 'k', 'v') → resp.ok == "OK"
engine.eval("return redis.call('SET', 'k', 'v')"); // { ok: Buffer.from("OK") }
engine.eval("return redis.call('SET', 'k', 'v').ok"); // Buffer.from("OK")

// Error reply: redis.pcall catches errors as {err: "..."}
// In Lua: local resp = redis.pcall('INVALID') → resp.err == "ERR ..."
engine.eval("return redis.pcall('INVALID')"); // { err: Buffer.from("..."), code: Buffer.from("ERR") }
```

> **Note**: Status replies (`+OK`) become `{ok: "..."}` tables in Lua, matching real Redis behavior.
> Use `resp.ok` to access the status string.

## Resource Limits

Protect against runaway scripts with configurable limits:

```typescript
const module = await load({
  limits: {
    maxFuel: 10_000_000, // Instruction budget
    maxReplyBytes: 2 * 1024 * 1024, // Max encoded reply size
    maxArgBytes: 1 * 1024 * 1024, // Max encoded KEYS + ARGV size
  },
});
const engine = module.create(host);
```

| Limit            | Description                                   | On overflow                                 |
| ---------------- | --------------------------------------------- | ------------------------------------------- |
| `maxFuel`        | Instruction count budget                      | Script error (the script is stopped)        |
| `maxReplyBytes`  | Size of the encoded script reply              | `ERR reply exceeds configured limit`        |
| `maxArgBytes`    | Size of the encoded KEYS + ARGV array         | `ERR KEYS/ARGV exceeds configured limit`    |

All limits are enforced by the WASM runtime; unset or 0 means no limit. Each
must be a non-negative integer: `load()` throws a `RangeError` for negative,
fractional or non-finite values (so e.g. `0.5` cannot silently mean "no
limit"), and values above 2^32 - 1 are capped to it. `maxReplyBytes` is checked
while the reply is encoded, so a small value that expands into a huge reply
(e.g. a table referencing the same subtable many times) fails as soon as it
crosses the limit. It covers the script's return value (including returned
`{err=}` / `{ok=}` tables), not script errors or `redis.call` replies.
`maxArgBytes` counts the ABI encoding: 4 bytes, plus 4 bytes and the data of
each key and argument.

`maxFuel` (default 10,000,000) is a deterministic budget of Lua VM instructions,
charged in steps of 1000, not Redis's wall-clock `lua-time-limit` /
`busy-reply-threshold`. The engine runs one script synchronously, so there is no
`BUSY` reply, `SCRIPT KILL` or `SHUTDOWN NOSAVE`, and time spent in host callbacks
or inside C functions such as `string.rep` is not charged. A script that spends the
budget aborts with `{ err: "Script killed by fuel limit", code: "ERR" }` plus the
usual `meta` (`line`, `sha`), where a killed Redis script reports
`ERR Script killed by user with SCRIPT KILL...`. As in Redis after `SCRIPT KILL`,
the kill cannot be caught: once raised it is raised again at every instruction, so
it escapes any `pcall` or `xpcall` and reaches the host; no `xpcall` message
handler runs for it, and a kill inside a coroutine stops the whole script. Each
evaluation starts with the full budget. Known gap: a coroutine that finishes
within 1000 instructions is never charged, so a script that runs its work in
many short coroutines is not bounded by `maxFuel` (#75).

The WASM heap is fixed at 64 MB. A script that exhausts it fails with an ordinary
`not enough memory` error and the engine stays usable. Because Lua 5.1 has no
emergency garbage collection, the engine runs a full collection after any
evaluation that leaves more than 16 MB of Lua memory in use, so a heavy script's
garbage (whether it succeeded, failed, or caught and rethrew an out-of-memory
error) does not make the next script run out of memory; if that collection
itself runs out of memory, the Lua VM is discarded and rebuilt. A script, KEYS
or ARGV too large to copy into the heap makes `eval` / `evalWithArgs` throw a
`RangeError`; KEYS/ARGV that fit as bytes but not as Lua strings reply
`ERR not enough memory to set KEYS/ARGV`. In both cases the engine stays usable.

## Included Lua Libraries

The engine includes Redis-standard Lua modules:

- **cjson** - JSON encoding/decoding
- **cmsgpack** - MessagePack serialization
- **struct** - Binary data packing/unpacking
- **bit** - Bitwise operations

Plus standard Lua 5.1 libraries: `base`, `table`, `string`, `math`.

## Use Cases

- **Powering [js-redis-server](https://github.com/fatal10110/js-redis-server)** - the primary use case: providing `EVAL`/`EVALSHA` scripting for an in-memory Redis-compatible server
- **Testing** - Unit test Redis Lua scripts without a Redis server
- **Sandboxing** - Execute untrusted Lua with resource limits
- **Development** - Rapid iteration on Lua scripts locally
- **Embedding** - Add Redis-compatible scripting to Node.js applications

## Compatibility

| Feature                         | Status  |
| ------------------------------- | ------- |
| Redis version target            | 7.x     |
| Lua version                     | 5.1     |
| Binary-safe strings             | Yes     |
| `redis.call` / `redis.pcall`    | Yes     |
| `redis.log`                     | Yes     |
| `redis.sha1hex`                 | Yes     |
| Standard Lua libraries          | Yes     |
| Redis Lua modules (cjson, etc.) | Yes     |
| Debug / REPL helpers            | No      |
| Redis Modules API               | Not yet |

## Building from Source

```bash
# Build everything (requires Emscripten via Docker)
npm run build

# Build steps individually
npm run build:wasm  # Compile C to WASM
npm run build:ts    # Compile TypeScript

# Run tests
npm test
npm run test:skip-wasm  # Skip WASM rebuild
```

## Documentation

- [Host Interface Contract](docs/host-interface.md)
- [Binary ABI Specification](docs/abi.md)
- [Limits and Compatibility](docs/limits-compat.md)

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- How to report bugs
- How to suggest enhancements
- Development setup
- Pull request process
- Coding standards

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## Security

Security is important to us. If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) for responsible disclosure.

For general security considerations when using lua-redis-wasm, see the [Security Guide](SECURITY.md#security-considerations).

## Support

- **Issues**: [GitHub Issues](https://github.com/fatal10110/lua-redis-wasm/issues)
- **Discussions**: [GitHub Discussions](https://github.com/fatal10110/lua-redis-wasm/discussions)
- **Documentation**: [docs/](docs/)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each release.

## License

This package is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

The WASM module is built from C sources vendored from
[Valkey](https://github.com/valkey-io/valkey) (the `vendor/valkey` submodule, pinned to a
release tag), and parts of this project's C code are derived from Valkey / Redis 7.2.4.
It includes third-party code under the BSD 3-Clause License:

- **Valkey / Redis 7.2.4** (derived scripting code, Lua core modifications, `rand.c`) -
  Copyright (C) 2006-2020 Redis Ltd., (C) 2024-present Valkey contributors

under the MIT License:

- **Lua 5.1** - Copyright (C) 1994-2012 Lua.org, PUC-Rio
- **lua_cjson**, **strbuf**, **fpconv** - Copyright (C) 2010-2012 Mark Pulford
- **lua_cmsgpack** - Copyright (C) 2012 Redis Ltd.
- **lua_struct** - Copyright (C) 2010-2018 Lua.org, PUC-Rio
- **lua_bit** - Copyright (C) 2008-2012 Mike Pall

and under the Boost Software License 1.0:

- **fpconv_dtoa** - Copyright (C) 2013-2019 night-shift, (C) 2009 Florian Loitsch,
  (C) 2021 Redis Ltd.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full license texts.

## Acknowledgments

- Redis team for the Lua integration design
- Emscripten project for WebAssembly tooling
- Contributors and maintainers of the included Lua libraries
