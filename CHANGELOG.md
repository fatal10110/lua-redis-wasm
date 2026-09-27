# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `redisCall`/`redisPcall` handlers receive a second `ctx: { source, line }`
  argument describing the caller (new WASM exports `current_call_source` /
  `current_call_line`), so hosts can build Redis 6.2's `@user_script: N:` prefix
  for `redis.pcall` errors (#28).

- Dedicated **browser** build with no `node:*` imports, selected automatically via
  the `browser` condition in `package.json` `exports`. Browser bundlers (Vite,
  webpack, Rollup) now resolve the package without aliasing or stubbing `node:fs`,
  `node:fs/promises`, `node:path`, `node:url`, or `node:crypto`. The Node build is
  unchanged in behavior and selected via the `node` condition.

- `reseedRandom` compat override: reseed `math.random` with 0 before every
  script. Set by the `redis-6.2` profile only (#45).
- `compat.tableErrors` option (WASM compat flag `0x10`) selecting the Redis 7
  error model described below; on for every profile except `redis-6.2` (#48).

### Changed

- The vendored C sources (Lua 5.1 with cjson/cmsgpack/struct/bit, `fpconv`,
  `rand.c`) now come from Valkey 8.0.11 (BSD-3-Clause, `vendor/valkey` submodule)
  instead of the Redis 8.4 tree (`vendor/redis`), whose newer files are licensed
  under RSALv2/SSPLv1/AGPLv3. Valkey 8.0.11's Lua is the same code as Redis 8.4's
  apart from `cjson.decode_array_with_array_mt` (see Removed): it carries the same
  security fixes (CVE-2024-31449, CVE-2025-46817, CVE-2025-46818, CVE-2025-46819,
  CVE-2025-49844) and the same string hashing, so table iteration order is
  unchanged. `THIRD_PARTY_NOTICES.md` now covers the BSD-3-Clause code from
  Valkey / Redis 7.2.4 (including the portions of `wasm/src` derived from it),
  `strbuf.c`, `fpconv.c` and `fpconv_powers.h`.
- WASM ABI version 1: `host_redis_log` and `host_redis_setresp` return a `PtrLen`
  (`{0,0}` on success, otherwise the error message C raises as a Lua error), and
  every `PtrLen`-returning export and import uses the struct-return pointer only.
  The speculative non-sret plumbing is removed (`packPtrLen`/`unpackPtrLen`,
  `getTempRet0`, arity detection); `WasmExports` / `HostImport` are typed
  accordingly (#52).
- The WASM module links with `-sABORTING_MALLOC=0`: an exhausted heap makes
  `malloc` return 0 instead of aborting the module (#40).
- The loader is split into `loader.ts` (Node: reads glue/`.wasm` from disk) and
  `loader.browser.ts` (browser: `fetch`), over a shared platform-agnostic
  `loader-core.ts`. The browser build aliases `./loader.js` to the browser loader,
  so no Node builtin enters the browser graph.
- SHA-1 (for EVALSHA digests) now uses a dependency-free synchronous implementation
  (`sha1.ts`) instead of `node:crypto`, so the browser build needs no `crypto`
  polyfill. Output is byte-for-byte identical to `crypto.createHash("sha1")`.
- Build outputs renamed: `dist/index.node.{mjs,cjs}` (Node) and
  `dist/index.browser.mjs` (browser). The package entry (`import "lua-redis-wasm"`)
  is unchanged; only internal file names moved.
- `maxReplyBytes` and `maxArgBytes` are enforced only by the WASM runtime; the
  duplicate checks in `LuaEngine` are gone (#53). KEYS/ARGV over `maxArgBytes`
  are now copied into the heap before being rejected, so ones too large for the
  heap throw `RangeError` rather than returning the limit error.
- `load()` throws a `RangeError` for a limit that is not a non-negative integer
  (negative, fractional, `NaN`, `Infinity`, non-numeric), and limits above
  2^32 - 1 saturate instead of wrapping around in the WASM call.
- The script's SHA1 is computed only when a script error is built, not on every
  `eval` / `evalWithArgs` (#57).
- Redis 7 error model for the `redis-7.x`, `redis-8.0` and `valkey-*` profiles
  and the default (#48): `redis.call` raises an `{err=...}` table instead of a
  string (the same table `redis.pcall` returns, with
  `ignore_error_stats_update=true`; a host error with no space in it gets the
  `ERR` code and trailing CR/LF is trimmed, like Redis's `luaPushErrorBuff`), as
  do `redis.log`, `redis.setresp` and the other `redis.*` errors, and the global
  `pcall` returns the `err` string of a caught error table, like Redis's
  `luaRedisPcall`. `pcall(redis.call, ...)` still yields a string; `xpcall`
  handlers now receive the table. `redis-6.2` keeps string errors. The error the
  host receives when a script aborts is unchanged, except that CR/LF around a
  host error's message is now trimmed as in Redis (`"\r\nboom"` → `boom`, was
  `"  boom"`).
- The fuel-limit kill is raised as `ERR Script killed by fuel limit` (code `ERR`,
  message `Script killed by fuel limit`) without a `user_script:N:` position
  prefix, and `redis.setresp` / `ERR empty reply from host` errors lose that
  prefix too. The fuel budget is documented as a deterministic instruction
  budget, not Redis's wall-clock `lua-time-limit` (#14).

### Removed

- `EngineLimits.maxMemoryBytes` (was never enforced) (#54).
- `cjson.decode_array_with_array_mt`, a Redis 8.x-only addition (redis/redis#14296)
  that Valkey does not have, is gone along with its encoder side: a table whose
  metatable has `__is_cjson_array` no longer encodes as a JSON array, so an empty
  one encodes as `{}` again, as in Valkey and Redis 7.x.

### Fixed

- `maxReplyBytes` is checked while the reply is encoded instead of after it is
  built in full: a small value that expands into a huge reply (a table holding
  the same subtable many times) fails straight away with
  `ERR reply exceeds configured limit` instead of first exhausting the heap
  (#69).
- Typed reply tables (`{double=}`, `{big_number=}`, `{map=}`, `{set=}`,
  `{verbatim_string=}`) in a script's return value now convert at any protocol
  level, matching real Redis 7.x/8.x. Previously they encoded as an empty array
  unless the script called `redis.setresp(3)`. Hosts serving RESP2 clients must
  convert these typed replies themselves (see README). Typed-table lookups now
  use raw access and exact type checks like Redis (`{double='1.5'}`, `{err=42}`
  and `{ok=1}` are no longer converted, `__index` metamethods are ignored),
  `\r`/`\n` in `big_number` are replaced with spaces, and `verbatim_string`
  formats are truncated or space-padded to exactly 3 bytes.
- `load()` (and `LuaWasmEngine.create`) now rejects with
  `Failed to instantiate redis_lua.wasm: ...` when WebAssembly instantiation fails
  (truncated/corrupt `.wasm`, unresolvable import) instead of hanging forever (#44).
- The WASM build links with undefined-symbol errors enabled: host imports are
  declared explicitly (`import_module("env")` in `abi.h` plus an Emscripten JS
  library), and the loader no longer aliases the `wasi_snapshot_preview1` import
  namespace to `env` (#56).
- Returning a deeply nested or cyclic table no longer hangs the host: the reply
  encoder grows the Lua stack with `lua_checkstack` like Redis and caps nesting
  at 1000 levels, replying `ERR reached lua stack limit` instead (#35). Redis
  places that error at the too-deep element; here it replaces the whole reply.
- The WASM decoder for host replies now grows the Lua stack with
  `lua_checkstack` and caps nesting at 1000 levels: a deeper reply raises
  `ERR reached lua stack limit` from `redis.call`/`redis.pcall` instead of
  overrunning the Lua stack (#50). The JS reply encoder (`encodeReplyValue`) is
  recursive, so a very deep host reply (about 3000 levels for arrays, less for
  `{map=}` replies or under nested `pcall` frames) can still overflow the JS
  stack before it reaches the decoder; that overflow surfaces as an error reply
  (see below). See `docs/limits.md`.
- Lua numbers outside the int64 range (including NaN and `±math.huge`) now
  convert to the integer reply `-9223372036854775808`, matching Redis on x86-64,
  instead of saturating (#46).
- A JS exception from a host callback no longer unwinds through the WASM frames
  and corrupts the Lua VM (#39). A throw from `log` / `onSetResp` is raised in the
  script as a Lua error (`onSetResp` then keeps the protocol); a malformed host
  `ReplyValue` (including one nested too deeply to encode) or a failure decoding
  arguments becomes an error reply for `redis.call` / `redis.pcall`.
  `eval` / `evalWithArgs` always free their buffers, and an exception that still
  escapes WASM marks the engine unusable (later calls throw
  `LuaEngine is unusable: ...`). A throwing `_alloc` is reported as the new
  exported `WasmFault` error class.
- WASM allocation failures are checked (#40): a script, KEYS/ARGV or host buffer
  that does not fit the 64 MB heap throws a `RangeError` (the engine stays usable)
  instead of writing at address 0. A Lua script exhausting the heap now gets an
  ordinary `not enough memory` error instead of aborting the module, and a full
  garbage collection runs after any evaluation that leaves more than 16 MB of
  Lua memory in use, so one heavy script's garbage cannot make the next one run
  out of memory. `cmsgpack.pack` still aborts when it runs out of heap (as with
  Redis's aborting allocator), which marks the engine unusable, instead of
  writing through a NULL buffer.
- Returning a function, coroutine or userdata (e.g. `cjson.null`) now replies
  nil in its place, at any depth (array elements, `{map=}` keys/values, `{set=}`
  members), like Redis, instead of failing the whole script with
  `ERR unsupported Lua return type`. That error is gone; the only remaining
  reply encoding failure (out of memory) reports `ERR reply encoding failed`
  (#66).
- Number arguments to `redis.call`/`redis.pcall` are formatted like Redis 7.4+
  instead of with Lua's lossy `%.14g`: integral values up to 2^62 in magnitude as
  integers (`1e15` → `1000000000000000`), others in the shortest round-trip form
  via Redis's `fpconv_dtoa` (`0.1+0.2` → `0.30000000000000004`). The same for
  every compat profile; the `redis-7.2` profile thus matches Redis 7.2.5+
  (7.2.0–7.2.4 sent `1e15` as `1e+15`) (#68).
- `math.random` / `math.randomseed` now use Redis's PRNG (`redisLrand48` /
  `redisSrand48` from `vendor/redis/src/rand.c`) instead of libc
  `rand()`/`srand()`, so they return the same numbers as a real server (#45).
  As in Redis 7.0+ and Valkey, one sequence runs across scripts for the life of
  the engine (a new engine's first `math.random(1,1000000)` is `396465`, like a
  freshly started server), and a `math.randomseed` carries over to later
  scripts. The `redis-6.2` profile reseeds with 0 before every script, like
  Redis 6.2 (`170829` every time).
- Running out of memory outside the script body no longer aborts the module
  through Lua's panic handler (#41). KEYS/ARGV setup runs in protected mode (a
  huge ARGV replies `ERR not enough memory to set KEYS/ARGV`), as do VM setup
  (library loading), reply encoding and the post-run collection. A Lua error
  that still escapes protection is caught by a `lua_atpanic` handler: the VM is
  rebuilt and the call replies `ERR unprotected Lua error (...); the Lua VM was
  reset`. The VM is also rebuilt when the post-run collection itself runs out
  of memory (Lua 5.1 shrinks the string table by allocating first, which can
  keep failing on a full heap), and an eval whose reply could not be allocated
  now replies `ERR not enough memory for the script reply` instead of `null`.
  An `eval` / `evalWithArgs` called from inside a host callback while a script
  is running now replies `ERR nested eval is not supported: a script is
  already running` instead of running on (and possibly closing) the VM under
  the outer script.
- `error({err='MY custom'})` and `error(redis.error_reply('boom'))` report the
  table's `err` field (`MY custom`, `ERR boom`) instead of
  `ERR script execution failed`, like Redis's `luaExtractErrorInformation`
  (`ERR unknown error` when `err` is not a string); other non-string error values
  are reported as Lua's `tostring` renders them (`nil`, `true`, ...) (#37). This
  is Redis 7.0+ behavior, applied to every profile (Redis 6.2 fails on a table
  error).
- The fuel limit can no longer be bypassed with `pcall` (#38): like Redis after
  `SCRIPT KILL`, a spent budget switches the hook to fire on every instruction
  and line, so the kill is raised again after any `pcall` / `xpcall` catches it
  until it escapes the script. No `xpcall` message handler runs for the kill, and
  a kill inside a coroutine stops the whole script even if `coroutine.resume`
  returned it as a value. The counting hook is restored before the next
  evaluation. Coroutines that finish within 1000 instructions are still not
  charged (#75).

## [1.3.0] - 2026-06-08

### Added

- `REPLY_SCRIPT_ERROR` (0x06) ABI reply tag, emitted by the `eval` / `eval_with_args`
  abort paths (load and runtime failures). The engine decorates **only** this tag with
  `script: <sha>, on @user_script:<line>.`, so errors that abort a script (a propagated
  `redis.call` error or an uncaught runtime error) are decorated while error values a
  script returns (e.g. `return redis.pcall(...)`) are passed through untouched — matching
  Redis.
- Structured error code on the error reply: the `ReplyValue` error variant is now
  `{ err: Buffer; code?: Buffer }`. The codec splits the leading Redis error code
  (`[A-Z][A-Z0-9]*`) out of the payload on decode and re-joins it on encode, so hosts can
  read `code` directly instead of parsing the message string.

### Changed

- `redis.call()` / `redis.pcall()` with no arguments are now dispatched to the host with
  an empty argument list instead of short-circuiting in C. The host owns the exact error
  message, and the call/pcall distinction is preserved natively.

### Notes

- These changes are additive (`code` is optional) and behavior-only for the zero-arg case,
  but consumers that previously parsed `{ err }` strings to recover an error code should
  read the new `code` field instead.

## [1.2.2] - 2025-01-18

- Baseline published release: WebAssembly Redis Lua 5.1 engine with `redis.call` /
  `redis.pcall` / `redis.log` host integration, `cjson` / `cmsgpack` / `struct` / `bit`
  modules, resource limits, and binary-safe replies.

[1.3.0]: https://github.com/fatal10110/lua-redis-wasm/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/fatal10110/lua-redis-wasm/releases/tag/v1.2.2
