# Redis 7 Lua Compatibility Scope

## Target
- Redis version: 7.x by default; Redis 6.2–8.0 and Valkey 8.0–9.0 through
  [compatibility profiles](#compatibility-profiles)
- Lua version: 5.1 (from the vendored Valkey 8.0.11 sources)
- Host: Node.js and browsers

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
- Any OS, IO, or time-dependent Lua libraries (the `os` library, where a
  profile enables it, is sandboxed to `os.clock` as in Redis).

## Compatibility Profiles

The `profile` option (`load()`, `LuaEngine.create`, `LuaEngine.createStandalone`)
selects the Lua sandbox behaviors that differ across Redis/Valkey versions, and
`compat` overrides single flags on top of it. The engine passes them to the WASM
module as a bitmask (`set_compat`):

| Flag (`compat` key) | WASM bit | `redis-6.2` | `redis-7.0` / `redis-7.2` | `redis-7.4` / `redis-8.0` | `valkey-8.0` / `valkey-9.0` | no profile |
|---|---|---|---|---|---|---|
| `print` global (`print`) | `0x01` | on | off | off | off | off |
| sandboxed `os` library (`os`) | `0x02` | off | off | on | on | on |
| `server` alias of `redis` (`serverAlias`) | `0x04` | off | off | off | on | on |
| reseed `math.random` before every script (`reseedRandom`) | `0x08` | on | off | off | off | off |
| Redis 7 error model (`tableErrors`) | `0x10` | off | on | on | on | on |
| `Invalid debug level.` wording (profile only) | `0x20` | on | on | off | off | off |
| Valkey wording (profile only) | `0x40` | off | off | off | on | off |

Profiles in the same column behave identically. With no profile the behavior
is that of `valkey-8.0`, except for the wording: the `redis.log` arity error
names `redis.log()` and a bad `redis.call` / `redis.pcall` argument says `Lua
redis lib command arguments ...`, as in Redis 7.4+. The two wording bits follow
the profile only and have no `compat` override.

## Host-Injectable `redis.*` Props

The engine ships **none** of the version-specific `redis.*` members by default (a
blank slate) — there is no bundled `REDIS_VERSION`, and `redis.replicate_commands()`
etc. do not exist unless the host adds them. A host that needs them supplies the
`redisProps` option (see [README](../README.md#add-redis-constants-and-stubs)):

- `REDIS_VERSION`, `REDIS_VERSION_NUM` — version constants.
- `REPL_ALL`, `REPL_AOF`, `REPL_SLAVE`, `REPL_REPLICA`, `REPL_NONE` — replication
  flag constants.
- `replicate_commands` — stub function, typically `{ returns: true }`.
- `set_repl` / `get_repl` — stub functions, typically `{ returns: null }` (noop) /
  `{ returns: <flag> }`.

`redisProps` supports two shapes per member: `{ value }` for a constant field, or
`{ returns }` for a stub function that ignores its arguments and returns the given
constant (`returns: null` makes it return nothing). `server`, where the profile
enables it (`serverAlias`), is an alias of `redis` (same table, same injected
props) — it is not configured through `redisProps`. Numeric values follow
Redis's number semantics: a Lua number returned from a script is truncated to
an integer, so a non-integer numeric prop reads back truncated.

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
- `redis.error_reply`, `redis.status_reply`, `redis.call` / `redis.pcall`,
  `redis.log` and `redis.sha1hex` follow the profile, checked against each
  version's source (`src/scripting.c` in 6.2, `src/script_lua.c` later):
  - with the Redis 7.0+ error model, `redis.error_reply` derives the code
    (`'foo'` → `ERR foo`, `'-ERR x'` → `ERR x`), a bad `error_reply` /
    `status_reply` call (anything but one string argument) returns
    `{err='ERR wrong number or type of arguments'}`, and `redis.log`,
    `redis.setresp` and `redis.sha1hex` errors carry the `ERR` code; Redis 6.2
    returns the `error_reply` string unchanged, positions a bad `error_reply` /
    `status_reply` call as
    `@user_script: <line>: wrong number or type of arguments`, and raises
    `redis.log`, `redis.setresp` and `redis.sha1hex` argument errors without a
    code or position. These follow `compat.tableErrors`.
  - `redis.sha1hex` with no argument or more than one raises
    `wrong number of arguments` (`ERR`-coded in the Redis 7.0+ error model).
    Its one argument is read with `lua_tolstring` in every version, so `nil`,
    a boolean or a table hashes as the empty string, with no error.
  - a `redis.pcall` argument that is not a string or number returns (does not
    raise) `{err='ERR Lua redis lib command arguments must be strings or
    integers'}` (Redis 7.x/8.0 profiles, no profile), `{err='ERR Command
    arguments must be strings or integers'}` (Valkey profiles), or, without
    table errors, `{err='@user_script: <line>: Lua redis() command arguments
    must be strings or integers'}` (Redis 6.2). `redis.call` raises that error
    instead (the table, or Redis 6.2's string), so a script that catches it
    (`pcall(redis.call, 'set', 'k', {})`) sees the same message, `=[C]: -1: ...`
    in Redis 6.2 when `pcall` calls `redis.call` directly. Uncaught, the host
    gets it as the `command-arg-type` engine error, which it words.
  - a read of a nonexistent global raises
    `user_script:<line>: Script attempted to access nonexistent global variable
    '<name>'` in every profile, which is what a script that catches it sees;
    uncaught, the host gets the `global-read` engine error. A key that is not
    a string or number (`_G[true]`) raises Redis's ordinary
    `user_script:<line>: Second argument to luaProtectedTableError must be a
    string or number` instead.
  - an invalid `redis.log` level is `Invalid debug level.` on `redis-6.2`,
    `redis-7.0` and `redis-7.2`, and `Invalid log level.` on `redis-7.4`,
    `redis-8.0` and the Valkey profiles (redis/redis#12636);
  - the Valkey profiles name `server.log()` in the arity error
    (`server.log() requires two arguments or more.`), the Redis ones
    `redis.log()`.
  - The `Invalid debug level.` / `Invalid log level.` choice and the Valkey
    wording (`server.log()`, `Command arguments ...`) follow the profile only
    (there is no override); with no profile it is the Redis 7.4+ wording
    (`redis.log()`, `Invalid log level.`, `Lua redis lib command arguments
    ...`). The Redis 6.2 `redis.pcall` form (`@user_script: <line>: Lua
    redis() ...`) follows `compat.tableErrors` instead, like the other 6.2
    forms above: `redis-8.0` or `valkey-8.0` with `tableErrors: false` gets it,
    and `redis-6.2` with `tableErrors: true` gets `ERR Lua redis lib ...`.
- An uncaught table error is reported by its `err` field, like Redis 7.0+'s
  `luaExtractErrorInformation`. This applies to every profile; Redis 6.2 itself
  fails on a table error.
- Script timeouts are an instruction budget (`maxFuel`), not a wall-clock
  `lua-time-limit`; see [limits](limits.md).
- What the host receives for each error, and the `meta` it carries, is in
  [errors.md](errors.md).

### `redis.log` wording

The `redis.log` argument errors follow the `profile`, as in each version's
source:

| profile | arity error | level error | `ERR` code |
|---|---|---|---|
| `redis-6.2` | `redis.log() requires ...` | `Invalid debug level.` | no |
| `redis-7.0`, `redis-7.2` | `redis.log() requires ...` | `Invalid debug level.` | yes |
| `redis-7.4`, `redis-8.0`, no profile | `redis.log() requires ...` | `Invalid log level.` | yes |
| `valkey-8.0`, `valkey-9.0` | `server.log() requires ...` | `Invalid log level.` | yes |

The `ERR` code came with the Redis 7 error model, so it follows
`compat.tableErrors`; the wording itself follows the profile only.

### Number arguments to `redis.call`

Number arguments are formatted like Redis 7.4+ for every profile; see
[host-interface.md](host-interface.md#rediscall) for the exact rules and how
older versions differ.

## Compatibility Criteria
- Return values and errors match Redis 7 behavior for the supported surface.
- All input and output are binary-safe (no UTF-16 string assumptions).
- Error messages and type coercion follow Redis 7 rules.
- RESP3 booleans, doubles, maps, sets, big numbers, and verbatim strings are
  supported for Lua returns and host replies.
