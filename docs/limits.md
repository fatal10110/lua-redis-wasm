# Resource Limits

This page is the detailed reference behind the README's
[Limit script runtime and size](../README.md#limit-script-runtime-and-size)
section.

## Configurable limits

Pass `limits` to `LuaEngine.create` / `LuaEngine.createStandalone` / `load()`.
All limits are enforced by the WASM runtime.

| Limit | Default | Meaning | On overflow |
|---|---|---|---|
| `maxFuel` | 10,000,000 | Lua VM instructions per evaluation | `ERR Script killed by fuel limit` |
| `maxReplyBytes` | no limit | Size of the encoded script reply | `ERR reply exceeds configured limit` |
| `maxArgBytes` | no limit | Size of the encoded KEYS + ARGV array | `ERR KEYS/ARGV exceeds configured limit` |

- Each limit must be a non-negative integer: `load()` throws a `RangeError` for
  negative, fractional, non-finite or non-numeric values (so e.g. `0.5` cannot
  silently mean "no limit"). Values above 2^32 - 1 are capped to it.
- `0` or unset means no limit for `maxReplyBytes` and `maxArgBytes`. For
  `maxFuel` it means the default budget: the fuel limit cannot be turned off,
  only raised (up to 2^32 - 1 instructions).
- `maxReplyBytes` is checked while the reply is encoded, so a small value that
  expands into a huge reply (e.g. a table referencing the same subtable many
  times) fails as soon as it crosses the limit. It covers the script's return
  value (including returned `{err=}` / `{ok=}` tables), not script errors or
  `redis.call` replies.
- `maxArgBytes` counts the ABI encoding: 4 bytes, plus 4 bytes and the data of
  each key and argument. A larger KEYS/ARGV fails without running the script.

## Execution limits (fuel)
- `maxFuel` is a deterministic budget of Lua VM instructions, charged in steps
  of 1000, not Redis's wall-clock `lua-time-limit` / `busy-reply-threshold`. The
  engine runs one script synchronously, so there is no `BUSY` reply,
  `SCRIPT KILL` or `SHUTDOWN NOSAVE`, and time spent in host callbacks or inside
  C functions such as `string.rep` is not charged.
- Each evaluation starts with the full budget.
- A script that spends the budget aborts with
  `{ err: "Script killed by fuel limit", code: "ERR" }` plus the usual `meta`
  (`line`, `sha`), where a killed Redis script reports
  `ERR Script killed by user with SCRIPT KILL...`.
- Like a Redis `SCRIPT KILL`, it cannot be caught: after a `pcall`/`xpcall`
  catches it, it is raised again at the next instruction until it escapes the
  script. No `xpcall` message handler runs for it, and a kill inside a
  coroutine stops the whole script.
- Known gap (#75): fuel is charged per thread every 1000 instructions, so a
  coroutine that finishes within 1000 instructions is never charged. Work
  spread over many short coroutines is not bounded by the budget.

## Memory
- The WASM heap is fixed at 64 MiB, of which 2 MiB is the C stack, leaving
  about 62 MiB for Lua and the engine's buffers. It does not grow, and it is
  per engine.
- A script that exhausts the heap fails with an ordinary `not enough memory`
  error and the engine stays usable; this includes `cjson.encode` of a value
  that expands into a document too large for the heap.
- Because Lua 5.1 has no emergency garbage collection, the engine runs a full
  collection after any evaluation that leaves more than 16 MiB of Lua memory in
  use, so a heavy script's garbage (whether it succeeded, failed, or caught and
  rethrew an out-of-memory error) does not make the next script run out of
  memory. If that collection itself runs out of memory, the Lua VM is
  discarded and rebuilt.
- A script, KEYS or ARGV too large to copy into the heap makes `eval` /
  `evalWithArgs` throw a `RangeError`; KEYS/ARGV that fit as bytes but not as
  Lua strings reply `ERR not enough memory to set KEYS/ARGV`. In both cases the
  engine stays usable.
- `cmsgpack.pack` still aborts when it runs out of heap (as with Redis's
  aborting allocator), which makes the engine unusable.

## Stack limits
These come from the Lua 5.1 build in `vendor/valkey/deps/lua` (`luaconf.h`):
- Lua stack slots usable by a C function (`lua_checkstack`): 8000
  (`LUAI_MAXCSTACK`).
- Nested Lua calls: 20000 (`LUAI_MAXCALLS`).
- Nested C calls (C functions, metamethods, `pcall`, `string.gsub` callbacks,
  `table.sort` comparators, coroutines) and parser nesting: 200
  (`LUAI_MAXCCALLS`). Past that the script gets Lua's `C stack overflow` error,
  as in Redis, and the engine stays usable. The module's 2 MiB C stack has room
  for that limit.

cjson nesting:
- `cjson.encode` / `cjson.decode` nest once per level of the value, up to
  `encode_max_depth` / `decode_max_depth` (1000 by default). A script may raise
  those limits, but the engine additionally stops cjson at about 4000 levels
  (about 2000 for objects) with the same catchable nesting error, because a few
  thousand more would exhaust the JavaScript engine's own stack, which throws a
  `RangeError` and leaves the engine unusable.

Reply nesting:
- Script return values: nested at most 1000 levels deep. Deeper (or cyclic)
  tables reply `ERR reached lua stack limit` instead of the value.
- Host replies decoded by `redis.call`/`redis.pcall`: the WASM decoder accepts
  up to 1000 levels, and deeper replies raise `ERR reached lua stack limit` in
  the script. The JS side encodes the host's `ReplyValue` recursively
  (`encodeReplyValue`), though, and that can overflow the JS stack before the
  WASM limit is reached: from about 3000 levels for arrays, and at lower depths
  for `{map=}` replies or when `redis.call` runs under many nested Lua `pcall`
  frames, because WASM frames share the JS stack. That failure surfaces as an
  error reply carrying `Maximum call stack size exceeded` (raised by
  `redis.call`, returned by `redis.pcall`), not as `ERR reached lua stack
  limit`. Keep host replies shallow.

## Safety Notes
- Limits are enforced consistently across all entrypoints.
- Limits are set when the module is loaded and apply to the engine created
  from it; `reset()` keeps them.
