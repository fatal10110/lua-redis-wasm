# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
