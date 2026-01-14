# Phase 3 — Redis API Bindings

## Goals
- Implement Redis 7 Lua bindings for core `redis.*` APIs.
- Ensure Redis-compatible return semantics.

## Work items
- Implement `redis` table in Lua state:
  - `redis.call` and `redis.pcall` as host imports.
  - `redis.log` with log levels.
  - `redis.sha1hex` (WASM or host implementation).
  - `redis.error_reply` and `redis.status_reply` constructors.
  - `redis.setresp` to toggle RESP2/RESP3 behavior.
- Return mapping:
  - Proper handling of Lua arrays vs maps.
  - Nil and false mapping to Redis replies.
  - Binary-safe return values.
- Error handling:
  - Ensure errors match Redis 7 error strings.
  - `pcall` behavior consistent with Redis.

## Artifacts
- `wasm/src/redis_api.c` with bindings.
- Unit tests for each Redis API function.

## Acceptance criteria
- Each API matches Redis 7 behavior for supported surface.
- Errors and status replies are byte-for-byte compatible.
