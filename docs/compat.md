# Redis 7 Lua Compatibility Scope

## Target
- Redis version: 7.x
- Lua version: 5.1
- Host: Node.js

## Supported Redis Lua APIs
- `redis.call`
- `redis.pcall`
- `redis.log`
- `redis.sha1hex`
- `redis.error_reply`
- `redis.status_reply`
- `redis.setresp`

## Supported Redis Lua Modules
- `cjson`
- `cmsgpack`
- `struct`
- `bit`

## Exclusions
- Debug helpers: `redis.debug`, `redis.breakpoint`.
- Replication helpers: `redis.set_repl`, `redis.get_repl`, `redis.replicate_commands`.
- Redis function library helpers: `redis.register_function` and related APIs.
- Any OS, IO, or time-dependent Lua libraries.

## Determinism and Sandbox Rules
- No file, OS, or network access.
- No clock or time APIs available in Lua.
- No randomness unless explicitly injected by the host.
- No native extensions beyond the supported Redis modules.

## Compatibility Criteria
- Return values and errors match Redis 7 behavior for the supported surface.
- All input and output are binary-safe (no UTF-16 string assumptions).
- Error messages and type coercion follow Redis 7 rules.
