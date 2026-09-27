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

### Changed

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

### Fixed

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
