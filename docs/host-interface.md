# Host Interface Contract

This document describes the callbacks a host implements for the engine. The
README's [Connect `redis.call` to your data](../README.md#connect-rediscall-to-your-data)
section is the short version.

## Overview
- The engine calls host functions to implement `redis.call`, `redis.pcall`,
  `redis.log` and (optionally) to report `redis.setresp`.
- All arguments are binary-safe and passed as `Buffer` values.
- Replies must be shaped as Redis-compatible reply values (`ReplyValue`).
- Host callbacks run synchronously, inside the running script.

## RedisHost

```ts
export type RedisCallContext = {
  readonly source: Buffer; // caller's chunk source, e.g. "@user_script"
  line: number;            // caller's line; -1 for a C caller, 0 when unknown
};

export type RedisCallHandler = (args: Buffer[], ctx?: RedisCallContext) => ReplyValue;
export type RedisLogHandler = (level: number, message: Buffer) => void;

export type RedisHost = {
  redisCall: RedisCallHandler;
  redisPcall: RedisCallHandler;
  log: RedisLogHandler;
  onSetResp?: (version: 2 | 3) => void;
};
```

The host reply ABI supports RESP2 replies plus RESP3 booleans, doubles, maps,
sets, big numbers, and verbatim strings. Push replies are not representable.

### redisCall
- Invoked for `redis.call(...)`.
- Receives the command name and arguments as `Buffer[]`.
- Returns a `ReplyValue`. To fail the command, return `{ err, code? }` or
  throw. `redis.call` raises the error in the script (see
  [errors.md](errors.md#errors-inside-the-script)).
- A thrown exception becomes an error reply carrying its message. When the
  message does not start with an uppercase error code, the generic `ERR` code
  is added (`throw new Error("oops")` → `ERR oops`, like Redis's
  `addReplyError`). A returned `{ err }` reply is passed on as is.
- A zero-argument `redis.call()` / `redis.pcall()` is delegated to the host
  with an empty `args` array; the host decides the error.

Number arguments are formatted like Redis 7.4+ (`luaArgsToRedisArgv`), not with
Lua's lossy `%.14g`: integral values up to 2^62 in magnitude as plain integers
(`1e15` → `1000000000000000`, `-0.0` → `0`), everything else in the shortest
round-trip form (`0.1+0.2` → `0.30000000000000004`, `1e300` → `1e+300`, `1/0` →
`inf`, `0/0` → `nan` or `-nan`). This applies whatever the `profile` compat
option. Older versions differ: Redis 7.2.0–7.2.4 always used the shortest form
(`1e15` → `1e+15`; 7.2.5+ matches 7.4), and Redis 7.0 and earlier used `%.17g`
(`3.3` → `3.2999999999999998`).

### redisPcall
- Invoked for `redis.pcall(...)`.
- Receives the command name and arguments as `Buffer[]`.
- Should return `{ err: Buffer, code?: Buffer }` instead of throwing, to match
  Redis. A throw is still caught and returned to the script as an error table.

### Call context
Both handlers receive `ctx: { source, line }`, the caller of
`redis.call`/`redis.pcall` exactly as Redis 6.2's `luaPushError` sees it (stack
level 1): `source` (a `Buffer`) is `"@user_script"` for the script, the chunk
for `loadstring` code, or `"=[C]"` (line `-1`) for a C caller such as
`pcall(redis.pcall, ...)`. `source` is empty when unknown.

Use it to emit Redis 6.2's pcall error prefix, keeping `source` as bytes (a
template literal would UTF-8-decode it):

```ts
const prefixed = Buffer.concat([ctx.source, Buffer.from(`: ${ctx.line}: `), message]);
```

`source` is copied from WASM memory on first access: read it inside the
handler, since a first read after the handler has returned throws. When
delegating between handlers, pass `ctx` along (`this.redisCall(args, ctx)`).

### log
- Invoked for `redis.log(level, ...)`.
- `level` is the numeric Redis log level (`redis.LOG_DEBUG` 0,
  `redis.LOG_VERBOSE` 1, `redis.LOG_NOTICE` 2, `redis.LOG_WARNING` 3), truncated
  to an integer, which must be 0..3.
- As in Redis, every argument after the level is joined with a space into
  `message` (a binary-safe `Buffer`). Arguments `lua_tolstring` cannot convert
  (nil, booleans, tables) are skipped and get no separator of their own.
- The handler receives every message; filtering by verbosity is up to the
  host.
- Argument errors are raised in the script (default wording):
  - fewer than two arguments: `ERR redis.log() requires two arguments or more.`
  - a level that is not a number: `ERR First argument must be a number (log level).`
  - a level outside 0..3: `ERR Invalid log level.`

  The wording follows the `profile` (see
  [compat.md](compat.md#redislog-wording)).

### onSetResp
- Optional. Invoked when the script calls `redis.setresp(n)` with the new
  version (`2` or `3`).
- The WASM encoder flips its own RESP mode regardless; this hook only lets the
  host mirror the protocol when choosing reply shapes for
  `redisCall`/`redisPcall`.
- Fires after validation, so it only ever receives `2` or `3`.

### Host callback failures
A host callback never breaks the engine:

- A throw from `redisCall` / `redisPcall`, or a malformed `ReplyValue` (e.g.
  `{ map: "x" }`, a non-Buffer `ok`, or a reply nested too deeply to encode),
  becomes an error reply carrying the exception message (with `ERR` added as
  described above): `redis.call` raises it, `redis.pcall` returns it as an
  error table.
- A throw from `log` or `onSetResp` is raised in the script as an ordinary Lua
  error with the exception message (a script can catch it with `pcall`); this
  differs from Redis, where `redis.log` cannot fail. It is raised like a
  `redisCall` throw: in the Redis 7 error model as an `{err=...}` table, with
  `ERR` added when the message has no code (`log sink down` →
  `ERR log sink down`, `ERR x` and `WRONGTYPE x` kept), so the host never gets
  `ERR ERR`; with `redis-6.2` as the message itself. A throwing `onSetResp`
  also leaves the protocol unchanged.

If an exception still escapes the WASM module, the engine becomes unusable; see
[errors.md](errors.md#exceptions-thrown-by-the-engine).

### Nested evaluation
A handler must not evaluate another script on the same engine: while a script
is running, `eval` / `evalWithArgs` / `compile` reply
`ERR nested eval is not supported: a script is already running` (Redis likewise
refuses `EVAL` and `SCRIPT LOAD` from inside a script), and `reset()` /
`dispose()` throw. Use a second engine, or run the script after the current
one returns.

## SCRIPT LOAD and compile

`engine.compile(script)` compiles a script without running it: it returns
`null` when the script is valid Lua, or the compile error reply `eval` would
give (`meta.kind` `"compile"`, see
[errors.md](errors.md#compile-errors)). No script code runs, so no host
callback is called, no global is set and no fuel is spent; the Lua VM is left
as it was. It works in standalone engines too. No limit applies to the
script's size other than the WASM heap, as for `eval` (`maxArgBytes` covers
`KEYS`/`ARGV` only).

The engine keeps no script cache: the host keeps the scripts by SHA1 and runs
them with `eval`, which compiles the script again. A host's `SCRIPT LOAD`:

```ts
import { createHash } from "node:crypto";

const scripts = new Map<string, Buffer>();

function scriptLoad(body: Buffer): string {
  const reply = engine.compile(body);
  if (reply) {
    if (reply.meta?.kind === "compile") {
      throw new Error(`ERR Error compiling script (new function): ${reply.err}`);
    }
    throw new Error(`${reply.code ?? "ERR"} ${reply.err}`); // no VM, nested call
  }
  const sha = createHash("sha1").update(body).digest("hex");
  scripts.set(sha, body);
  return sha;
}
```

For `EVAL` / `EVALSHA`, render a reply whose `meta.kind` is `"compile"` the
same way: `-ERR Error compiling script (new function): <err>`, without the
`script: <sha>, on @user_script:<line>.` suffix other script errors get. This
is Redis's wording on every version (6.2 to 8.x, Valkey 8.0 and 9.0).

A reply from `compile` without `meta` means nothing was compiled: `compile` was
called from a host callback (see above), or there is no Lua VM
(`ERR Lua VM not initialized`, after a failed `reset()`).

## ReplyValue

```ts
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
```

On decode, an error payload of the form `CODE message` is split into `err` (the
message) and `code` (the leading `[A-Z][A-Z0-9]*` token, when present). On
encode the `code` is prepended back, so the wire form is always Redis's
`CODE message`. `meta` is only set on the error replies `eval` returns (see
[errors.md](errors.md#meta)).

Typed tables (`{double=}`, `{big_number=}`, `{map=}`, `{set=}`,
`{verbatim_string=}`) in a script's return value convert at any protocol level,
like real Redis; `redis.setresp(3)` only changes how booleans and `redis.call`
replies are converted for the current script. Hosts serving RESP2 clients must
therefore convert typed replies themselves, even when `onSetResp(3)` was never
called. Real Redis sends a RESP2 client a bulk string for `double`,
`big_number` and `verbatim_string`, a flat key/value array for `map`, and a
plain array for `set`.

## Binary safety
- No string coercion is applied to arguments.
- If you need strings, decode them from `Buffer` with an explicit encoding.
- To return binary data, return a `Buffer` or `{ ok: Buffer }`.
