# Design: Host-injected `redis.*` props

**Issue:** [#12](https://github.com/fatal10110/lua-redis-wasm/issues/12) — Missing `redis.*` helpers (`replicate_commands`, `set_repl`/`get_repl`, `REPL_*`, `REDIS_VERSION*`, `server` alias).

**Date:** 2026-06-29

## Goal

Let the host inject arbitrary constant fields and simple stub functions onto the
`redis` table, instead of hardcoding each helper in C. Blank slate: the package
ships none of the issue-#12 props; the host supplies what it wants. The `server`
alias (Redis 7.4+) is created internally by the package, not by the host.

Out of scope: `register_function`/Functions library, `breakpoint`/`debug`
(Lua debugger), and any prop that needs per-call host dispatch. "Simple stub"
means a function that ignores its args and returns a fixed constant (or nothing).

## Interface

New optional `redisProps` on `LoadOptions` (inherited by `EngineOptions` and
`StandaloneOptions`). `RedisHost` is unchanged.

```ts
type RedisProp =
  | { value: string | number | boolean }            // redis[name] = value
  | { returns: string | number | boolean | null };  // redis[name] = function(...) return <returns> end
                                                      // returns: null => function(...) end (noop, returns nothing)

type RedisProps = Record<string, RedisProp>;

type LoadOptions = {
  /* ...existing fields... */
  redisProps?: RedisProps;
};
```

Each entry must have exactly one of `value` / `returns`. The encoder throws a
`TypeError` if both or neither are present.

`value` is a plain field. `returns` is a nullary-style stub: a function that
ignores all arguments and returns the given constant; `returns: null` returns
nothing (a true noop, e.g. `set_repl`).

## Usage

### Before (until now)

No mechanism existed; missing helpers fail at runtime.

```ts
const engine = await LuaWasmEngine.create({ host });
engine.eval("return redis.replicate_commands()"); // err: attempt to call a nil value
engine.eval("return redis.REDIS_VERSION");        // null
```

### After

```ts
const engine = await LuaWasmEngine.create({
  host,
  redisProps: {
    REDIS_VERSION:      { value: "7.4.0" },
    REDIS_VERSION_NUM:  { value: 0x070400 },
    REPL_NONE:          { value: 0 },
    REPL_AOF:           { value: 1 },
    REPL_SLAVE:         { value: 2 },
    REPL_REPLICA:       { value: 2 },
    REPL_ALL:           { value: 3 },
    replicate_commands: { returns: true },
    set_repl:           { returns: null },
    get_repl:           { returns: 3 },
  },
});

engine.eval("return redis.replicate_commands()"); // 1 (true)
engine.eval("return redis.REDIS_VERSION");        // Buffer "7.4.0"
engine.eval("return redis.REPL_ALL");             // 3
engine.eval("return server.REDIS_VERSION");       // Buffer "7.4.0" (server alias)
```

Omitting `redisProps` leaves the props absent (unchanged failure). The `server`
alias always points at the same `redis` table regardless of props.

## Mechanism

Typed binary blob delivered via a new host import; C decodes and sets fields
directly on the `redis` table (no Lua source generation).

Why a blob over generated Lua source: binary-safe prop names, no escaping, no
risk of running host-templated Lua. Why a host import over an `init` signature
change: mirrors the four existing `host_*` PtrLen imports, and `reset()` re-runs
it for free.

### Wire format (little-endian, mirrors the ArgArray encoding)

```
[count: u32]
per entry:
  [name_len: u32][name bytes]   // UTF-8/binary, pushed as a Lua lstring
  [kind: u8]                    // 0 = field, 1 = stub function
  [vtype: u8]                   // 0 = none(nil), 1 = bool, 2 = number(f64), 3 = string
  [payload]                     // bool: u8 | number: f64le | string: u32 len + bytes | none: (empty)
```

- `{ value }` → kind 0; vtype is 1/2/3 (never 0).
- `{ returns: x }` → kind 1; vtype 1/2/3.
- `{ returns: null }` → kind 1; vtype 0.

Lua 5.1 numbers are doubles; `f64` covers all `number` values including
`REDIS_VERSION_NUM` (`0x070400` is exactly representable).

### TypeScript side

- `src/codec.ts`: `encodeRedisProps(props: RedisProps): Buffer`. Validates each
  entry, encodes per the wire format.
- `src/engine.ts`: add a `props` mutable handler alongside `log`/`sha1hex`/
  `call`/`pcall`. `load()` encodes the blob once from `options.redisProps`; when
  `redisProps` is undefined or has no entries it encodes nothing and the handler
  returns `PtrLen{0,0}` (C treats `len == 0` as "no props"). Otherwise the
  handler allocates the blob into WASM memory on demand and returns its `PtrLen`
  (same alloc pattern as `sha1hex`). New import wired in `load()`:
  `host_redis_props: () => handlers.props()`.
- `src/loader-core.ts`: no change required (imports are injected generically);
  `WasmExports` unchanged.
- `src/types.ts`: add `RedisProp`, `RedisProps`, and `redisProps?` on
  `LoadOptions`. Export `RedisProp`/`RedisProps` from `engine.ts`.

### C side

- `wasm/include/abi.h`: declare `PtrLen host_redis_props(void);`.
- `wasm/src/redis_api.{h,c}`:
  - `void apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);`
    Reads the global `redis` table, decodes each entry, and assigns the field
    via `lua_pushlstring(name)` + value + `lua_settable` (binary-safe name).
  - Two C closures:
    ```c
    static int l_const_return(lua_State *L) { lua_pushvalue(L, lua_upvalueindex(1)); return 1; }
    static int l_noop(lua_State *L) { (void)L; return 0; }
    ```
    Field: push value, settable. Stub with value: push value as upvalue,
    `lua_pushcclosure(L, l_const_return, 1)`, settable. Stub noop (vtype 0):
    `lua_pushcclosure(L, l_noop, 0)`, settable.
  - `apply_redis_props` returns `int` (0 ok, -1 malformed). It bounds-checks
    every read; a truncated blob or bad `vtype` returns -1 (no `luaL_error`,
    since init runs unprotected and a longjmp would panic). `init`/`reset`
    propagate -1 as an init failure. (Blob is package-generated, so -1 only
    fires on a bug.)
- `wasm/src/runtime.c`: in both `init()` and `reset()`, after
  `register_redis_api(g_state)` and before `enable_globals_protection(g_state)`:
  1. `PtrLen p = host_redis_props();`
  2. if `p.ptr && p.len`, `apply_redis_props(g_state, buf, p.len)`, then `free_mem(p.ptr)`.
  3. Create the alias: get global `redis`, set global `server` to the same table.

  The `server` alias is unconditional (runs even with no props). Order matters:
  props and alias must precede `enable_globals_protection`, which recursively
  locks `redis` (and therefore `server`, the same table) readonly.

## Testing

- `test/` (node:test): `encodeRedisProps` unit tests — field vs stub vs noop,
  each vtype, validation throw on both/neither key, empty/undefined input.
- Engine integration (requires WASM rebuild): props absent by default;
  `value` fields readable; `returns` stub callable and returns the constant;
  `returns: null` stub callable and returns nothing
  (`select('#', redis.set_repl()) == 0`); `server` aliases `redis` and sees the
  same props; props survive `reset()`; injected props are readonly under
  globals protection (writing `redis.REDIS_VERSION = x` raises).

## Build impact

Touches C, so a WASM rebuild (Docker + Emscripten) is required:
`npm run build:wasm`. The ABI gains one import; `REDIS_LUA_WASM_ABI_VERSION`
stays `0` (additive, no layout change to existing imports/exports).
