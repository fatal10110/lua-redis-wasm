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
- `redis.setresp` (RESP2 and RESP3)

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
- `math.random` and `math.randomseed` use Redis's PRNG (the rand48 generator, `serverLrand48` in
  `vendor/valkey/src/rand.c`), so a given seed yields the same numbers as a real
  server. As in Redis 7.0+ and Valkey, one sequence runs across scripts: a new
  engine starts where a freshly started server does (the first
  `math.random(1,1000000)` is `396465`), `reset()` does not restart it, and
  `math.randomseed(n)` also sets it for the scripts that follow. The
  `redis-6.2` profile (`reseedRandom` override) reseeds with `0` before every
  script, like Redis 6.2, so every script sees the same sequence (first
  `math.random(1,1000000)` is `170829`). Redis 6.2's reseed from
  `redis.replicate_commands()` is not emulated (that function is not provided).
- No other randomness unless explicitly injected by the host.
- No native extensions beyond the supported Redis modules.

## Errors
- Redis 7.0+ error model (every profile except `redis-6.2`): `redis.call` and
  the other `redis.*` functions raise `{err=...}` tables, and the global `pcall`
  returns the `err` string of a caught error table. `redis-6.2` raises plain
  strings. Override with `compat.tableErrors`.
- `redis.error_reply` and `redis.log` follow the profile, checked against each
  version's source (`src/scripting.c` in 6.2, `src/script_lua.c` later):
  - with the Redis 7.0+ error model, `redis.error_reply` derives the code
    (`'foo'` → `ERR foo`, `'-ERR x'` → `ERR x`) and `redis.log` errors carry the
    `ERR` code; Redis 6.2 returns the `error_reply` string unchanged, positions a
    bad call as `@user_script: <line>: wrong number or type of arguments`, and
    raises `redis.log` errors without a code. These follow `compat.tableErrors`.
  - an invalid `redis.log` level is `Invalid debug level.` on `redis-6.2`,
    `redis-7.0` and `redis-7.2`, and `Invalid log level.` on `redis-7.4`,
    `redis-8.0` and the Valkey profiles (redis/redis#12636);
  - the Valkey profiles name `server.log()` in the arity error
    (`server.log() requires two arguments or more.`), the Redis ones
    `redis.log()`.
  - This wording follows the profile only (there is no override); with no
    profile it is the Redis 7.4+ wording (`redis.log()`, `Invalid log level.`).
- An uncaught table error is reported by its `err` field, like Redis 7.0+'s
  `luaExtractErrorInformation`. This applies to every profile; Redis 6.2 itself
  fails on a table error.
- Script timeouts are an instruction budget (`maxFuel`), not a wall-clock
  `lua-time-limit`; see [limits](limits.md).

## Compatibility Criteria
- Return values and errors match Redis 7 behavior for the supported surface.
- All input and output are binary-safe (no UTF-16 string assumptions).
- Error messages and type coercion follow Redis 7 rules.
- RESP3 booleans, doubles, maps, sets, big numbers, and verbatim strings are
  supported for Lua returns and host replies.
