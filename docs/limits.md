# Resource Limits

## Execution Limits
- Instruction fuel limit: 10,000,000 steps per script.
- Fuel exhaustion behavior: abort with a Redis error reply.

## Memory Limits
- WASM linear memory: 64 MiB max.
- Max argument buffer size: 8 MiB per call.
- Max reply size: 8 MiB per script result.

## Stack Limits
These come from the Lua 5.1 build in `vendor/redis/deps/lua` (`luaconf.h`):
- Lua stack slots usable by a C function (`lua_checkstack`): 8000
  (`LUAI_MAXCSTACK`).
- Nested Lua calls: 20000 (`LUAI_MAXCALLS`).
- Nested C calls (C functions, metamethods, `pcall`) and parser nesting: 200
  (`LUAI_MAXCCALLS`).

Reply nesting:
- Script return values: nested at most 1000 levels deep. Deeper (or cyclic)
  tables reply `ERR reached lua stack limit` instead of the value.
- Host replies decoded by `redis.call`/`redis.pcall`: the WASM decoder accepts
  up to 1000 levels, and deeper replies raise `ERR reached lua stack limit` in
  the script. The JS side encodes the host's `ReplyValue` recursively
  (`encodeReplyValue`), though, and that can overflow the JS stack before the
  WASM limit is reached: from about 3000 levels for arrays, and at lower depths
  for `{map=}` replies or when `redis.call` runs under many nested Lua `pcall`
  frames, because WASM frames share the JS stack. That failure surfaces as a
  `RangeError` from the host call, not as `ERR reached lua stack limit`. Keep
  host replies shallow.

## Safety Notes
- Limits are enforced consistently across all entrypoints.
- Limits are configurable at host initialization time.
