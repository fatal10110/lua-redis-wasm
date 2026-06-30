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
- Redis function library helpers: `redis.register_function` and related APIs.
- Any OS, IO, or time-dependent Lua libraries.

## Host-Injectable `redis.*` Props

The engine ships **none** of the version-specific `redis.*` members by default (a
blank slate) — there is no bundled `REDIS_VERSION`, and `redis.replicate_commands()`
etc. do not exist unless the host adds them. A host that needs them supplies the
`redisProps` option (see [README](../README.md#injecting-redis-props)):

- `REDIS_VERSION`, `REDIS_VERSION_NUM` — version constants.
- `REPL_ALL`, `REPL_AOF`, `REPL_SLAVE`, `REPL_REPLICA`, `REPL_NONE` — replication
  flag constants.
- `replicate_commands` — stub function, typically `{ returns: true }`.
- `set_repl` / `get_repl` — stub functions, typically `{ returns: null }` (noop) /
  `{ returns: <flag> }`.

`redisProps` supports two shapes per member: `{ value }` for a constant field, or
`{ returns }` for a stub function that ignores its arguments and returns the given
constant (`returns: null` makes it return nothing). `server` is created internally
as an alias of `redis` (same table, same injected props) — it is not configured
through `redisProps`.

## Determinism and Sandbox Rules
- No file, OS, or network access.
- No clock or time APIs available in Lua.
- No randomness unless explicitly injected by the host.
- No native extensions beyond the supported Redis modules.

## Compatibility Criteria
- Return values and errors match Redis 7 behavior for the supported surface.
- All input and output are binary-safe (no UTF-16 string assumptions).
- Error messages and type coercion follow Redis 7 rules.
