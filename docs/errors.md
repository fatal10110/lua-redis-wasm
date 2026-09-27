# Errors

This page is the detailed reference behind the README's
[Handle errors](../README.md#handle-errors) section. It covers what the host
receives when a script fails, how scripts see errors, and what `eval` throws.

## Error replies

`eval` / `evalWithArgs` do not throw when a script fails. They return an error
reply:

```ts
{ err: Buffer; code?: Buffer; meta?: ReplyErrorMeta }
```

- A script that **aborts** (an uncaught `error(...)`, a runtime error, a
  `redis.call` error that propagates, the fuel-limit kill) or does not compile
  (see [Compile errors](#compile-errors)) returns an error reply with `meta`.
- An error **value** the script returns (`return redis.pcall(...)`,
  `return redis.error_reply('x')`) is passed through untouched, with no `meta`,
  as in Redis.

The engine composes no user-facing wording of its own for engine errors; it
classifies them and lets the host render them (see [`meta`](#meta)).

### `code` and `err`

On the wire Redis sends `-<code> <message>`. The engine splits the leading
uppercase token (`[A-Z][A-Z0-9]*`) into `code`; write `-<code> <err>`, or
`-<err>` when `code` is absent.

- An uncaught **string** error always has code `ERR` and its whole message as
  `err`, whatever its first word (`error('MY boom', 0)` → code `ERR`, `err`
  `MY boom`), because Redis sends it as `-ERR <message>`. That includes `ERR`
  itself: `error('ERR x', 0)` → code `ERR`, `err` `ERR x`, which the host writes
  as `-ERR ERR x` like Redis 7.0+ (Redis 6.2: `... @user_script:1: ERR x`).
  The engine's own errors, and exceptions thrown by host callbacks, never read
  `ERR ERR` in the Redis 7 error model, where they are raised as error tables;
  with `redis-6.2` the engine's own are bare, and a host error is kept whole
  (`ERR ...` included), as Redis 6.2 does.
- In the Redis 7 error model (every profile but `redis-6.2`, see
  `compat.tableErrors`), an error **table**'s `err` is what Redis sends as-is,
  so a table error has a `code` only when its `err` starts with one:
  `error({err='MY boom'})` → code `MY`, `err` `boom`; `error({err='boom'})` →
  no `code`, `err` `boom` (Redis: `-boom script: ...`). A host command error
  reply keeps its code (`WRONGTYPE ...` → code `WRONGTYPE`), stays code-less
  when its first word is not an uppercase code (`"oops something"`), and has
  CR/LF around the message after the code trimmed (`"\r\nboom"` → `boom`).
- With `redis-6.2` string errors, which Redis 6.2 always sends as `-ERR ...`,
  every script error takes the string rule: `error({err='MY boom'})` → code
  `ERR`, `err` `MY boom`; `WRONGTYPE ...` → code `ERR`, `err` `WRONGTYPE ...`;
  a host error `ERR unknown command` → code `ERR`, `err`
  `ERR unknown command` (Redis 6.2 raises a command error's text as it is);
  `RESP version must be 2 or 3.` → code `ERR`; `"\r\nboom"` → `"  boom"`.
- An error table (`error({err='MY custom'})`, `error(redis.error_reply('boom'))`,
  a `redis.call` error) is reported by its `err` field, like Redis 7.0+
  (`ERR unknown error` when `err` is not a string); other non-string values as
  Lua's `tostring` renders them (`error(nil)` → `nil`). This applies to every
  profile, `redis-6.2` included, although Redis 6.2 itself fails on a table
  error (its error handler concatenates it as a string).
- The fuel-limit kill has code `ERR` and `err` `Script killed by fuel limit`,
  in every profile. So do the engine's own failures, uncaught, with their bare
  message: `reached lua stack limit` (a host reply nested too deeply for
  `redis.call`), `reply decoding failed`, `empty reply from host`,
  `host callback failed`, `sha1hex failed`.
- Script-aborting messages are cut at the first NUL, have trailing CR/LF trimmed
  and every other CR/LF mapped to a space, so they can be written into RESP as
  is.

Hosts should return plain, undecorated error messages from their callbacks.

### `meta`

`meta` is present on script-aborting errors:

- `line` (1-based script line) and `sha` (the script's SHA1) are always set.
  Decorate the message with them as Redis does:
  `<message> script: <sha>, on @user_script:<line>.` (not for a compile
  error, see below).
- `kind` `compile` marks a script that did not compile; see
  [Compile errors](#compile-errors). Its `err` is Lua's message.
- Any other `kind`, and `name`, are set only for errors the engine itself
  raises while the script runs. For these, `err` is the bare `kind`, a machine
  default the host replaces with Redis's wording:

  | `kind` | Raised for | Redis wording |
  |---|---|---|
  | `global-read` | reading a nonexistent global (`name` is the global's name, raw: it may contain CR/LF or NUL bytes) | `Script attempted to access nonexistent global variable '<name>'` (Redis 6.2 to 8.x) |
  | `command-arg-type` | a `redis.call` argument that is not a string or number (no `name`) | Redis 7.0+: `Lua redis lib command arguments must be strings or integers`; Redis 6.2: `Lua redis() command arguments ...`; Valkey 8.0+: `Command arguments ...` |

The engine flags these errors itself (see `SCRIPT_ERROR_ENGINE` in
[abi.md](abi.md)). Error text a script or a host command produces never gets a
`kind`, whatever it contains, with one exception: a string equal to the exact
message of an engine error raised earlier in the same eval, which cannot be told
apart from rethrowing that error.

A script that catches one of these errors sees Redis's message, never the
`kind` (see [below](#errors-inside-the-script)). Rethrown unchanged
(`error(e, 0)`, or the error table an `xpcall` handler got, `err` untouched), it
still reaches the host with its `kind`; `error(e)` raises a new,
position-prefixed error, reported like any other string error (as Redis
reports it).

Writing a global has no `kind`: it is blocked by Lua's native readonly flag (as
in real Redis), which recursively locks the whole globals tree, so the VM itself
raises `Attempt to modify a readonly table`, which passes through in `err`.

### Compile errors

A script that is not valid Lua fails before any of it runs. `eval`,
`evalWithArgs` and [`compile`](host-interface.md#script-load-and-compile)
return the same reply for it:

```ts
engine.eval("local a = 1\nreturn +");
// {
//   err: Buffer.from("user_script:2: unexpected symbol near '+'"),
//   code: Buffer.from("ERR"),
//   meta: { kind: "compile", line: 2, sha: "..." },
// }
```

- `err` is Lua's message, `user_script:<line>: ...`, and `code` is `ERR`, in
  every profile. `meta.line` is the line from that message.
- Redis (6.2 to 8.x, Valkey 8.0 and 9.0) replies
  `-ERR Error compiling script (new function): <err>` to `EVAL` and
  `SCRIPT LOAD` alike, with no `script: <sha>, on @user_script:<line>.` suffix
  (and no `Error running script` wrapper on Redis 6.2). Add that wording in the
  host.
- Running out of memory while compiling (a script of many megabytes) is a
  compile error too, with `err` `not enough memory`, as Redis reports any
  failure to load a script with this wording.
- The engine flags the error where the load fails (`SCRIPT_ERROR_COMPILE` in
  [abi.md](abi.md)), never from the text: a runtime error with the same text,
  such as `error("user_script:1: unexpected symbol near '+'", 0)` or the error
  of a `loadstring` inside the script, has no `kind`.

## Errors inside the script

By default, and with every `profile` except `redis-6.2`, scripts see the Redis
7.0+ error model: `redis.call` (and `redis.log`, `redis.setresp`, ...) raise an
`{err=...}` table, and the global `pcall` returns the `err` string of a caught
error table, so `pcall(redis.call, ...)` still yields a string while an `xpcall`
handler receives the table. A host command error becomes the same table
`redis.pcall` returns: `{err='CODE message', ignore_error_stats_update=true}`,
with the generic `ERR` code added to a message that has no space and trailing
CR/LF trimmed, as in Redis.

With `profile: "redis-6.2"` errors are plain strings and a host error reaches
the script verbatim; the `redis.log`, `redis.setresp` and `redis.sha1hex`
argument errors carry no `ERR` code (`RESP version must be 2 or 3.`), and
`redis.error_reply` returns its argument unchanged, as in Redis 6.2. The
`compat.tableErrors` option overrides the profile.

The engine's own failures that a script can catch (`reached lua stack limit`
for a host reply nested too deeply, `reply decoding failed`,
`empty reply from host`, `host callback failed`, `sha1hex failed`) follow the
same model: `{err='ERR ...'}` tables in the Redis 7 model, bare strings with
`redis-6.2`. An exception thrown by the host's `log` or `onSetResp` is raised
like one thrown by `redisCall`: in the Redis 7 model as an `{err=...}` table,
with the `ERR` code added when its message has none (`log sink down` →
`ERR log sink down`, `WRONGTYPE x` kept), and with `redis-6.2` as the message
itself. The fuel-limit kill cannot be caught, and the `unknown error` fallback
exists only for an uncaught error table; both reach the host as code `ERR` and
their bare message.

`redis.sha1hex` takes exactly one argument, as in Redis: no argument or more
than one raises `wrong number of arguments`, which a script that catches it
sees as `ERR wrong number of arguments` (Redis 7 model) or
`wrong number of arguments` (`redis-6.2`, with no `user_script:N:` position).
Like Redis, it reads that argument with `lua_tolstring`: a number hashes its
string form, and a value with none (`nil`, a boolean, a table) hashes as the
empty string.

A `redis.pcall` argument that is not a string or number
(`redis.pcall('set', 'k', {})`) is returned as an error table, as in Redis, and
the script goes on. Its wording is the engine's, by profile:
`{err='ERR Lua redis lib command arguments must be strings or integers'}`
(Redis 7.x/8.0 profiles and no profile), `{err='ERR Command arguments must be
strings or integers'}` (Valkey profiles), and, without table errors,
`{err='@user_script: <line>: Lua redis() command arguments must be strings or
integers'}` (Redis 6.2). Returned or rethrown, it is an ordinary error with no
`meta.kind`. `redis.call` raises the same error (the table, or the plain string
without table errors), so a script that catches it sees Redis's message:
`pcall(redis.call, 'set', 'k', {})` returns `false` and
`ERR Lua redis lib command arguments must be strings or integers` (Valkey
profiles: `ERR Command arguments ...`; Redis 6.2:
`=[C]: -1: Lua redis() command arguments ...`). Likewise a caught read of a
nonexistent global gives
`user_script:<line>: Script attempted to access nonexistent global variable '<name>'`.
Uncaught, these reach the host as the `command-arg-type` and `global-read`
engine errors.

Per-profile wording of `redis.log`, `redis.error_reply` and the other
`redis.*` errors is listed in [compat.md](compat.md#errors).

## `redis.error_reply` and `redis.status_reply`

`redis.error_reply(msg)` follows Redis 7.0+: one leading `-` is dropped. With no
space, `ERR ` is prepended (`'foo'` → `ERR foo`). Otherwise the message is kept
and its first token is the code, whatever its case (`'My Error'` stays
`My Error`, `'-ERR x'` → `ERR x`). On decode, a token that is not uppercase,
like `My`, stays in `err` with no `code`; the wire bytes are the same either
way. Any call but one string argument returns
`{err='ERR wrong number or type of arguments'}`.

With `profile: "redis-6.2"` (or `compat.tableErrors: false`) it follows Redis
6.2 instead: the string is returned unchanged (`'foo'` → `{err='foo'}`,
`'-ERR x'` → `{err='-ERR x'}`), and a bad call returns
`{err='@user_script: <line>: wrong number or type of arguments'}` with no code.

`redis.status_reply(msg)` returns `{ok=msg}` for one string argument. Like
`redis.error_reply`, any other call (no argument, a number, extra arguments)
returns, without raising, `{err='ERR wrong number or type of arguments'}`, or
the Redis 6.2 form above with `profile: "redis-6.2"` /
`compat.tableErrors: false`.

## Exceptions thrown by the engine

`eval` / `evalWithArgs` / `compile` throw only when the engine itself cannot
run the script:

| Exception | Cause | Engine afterwards |
|---|---|---|
| `RangeError` | the script, KEYS or ARGV does not fit in the 64 MB WASM heap | usable |
| `WasmFault` (exported) | the module's `_alloc` threw | unusable |
| other `Error` | a WASM trap or abort (e.g. `cmsgpack.pack` running out of heap aborts, as in Redis) | unusable |
| `Error: LuaEngine is unusable: ...` | an earlier call failed as in the two rows above (`cause` holds the original error) | unusable |
| `Error: LuaEngine has been disposed` | `dispose()` was called | disposed |

`compile` also throws when a custom WASM binary built before it existed (ABI
version 3 or older) has no `compile` export; the engine stays usable.

`reset()` throws the same way (and also when called from a host callback). If
it cannot build the new Lua VM (out of memory, or the `redisProps` cannot be
applied), it throws and the engine keeps no VM: every `eval` replies
`ERR Lua VM not initialized` until a later `reset()` succeeds.

An unusable engine cannot be trusted any more: create a new one. Host callback
exceptions never make an engine unusable; see
[Host callback failures](host-interface.md#host-callback-failures).

```ts
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
