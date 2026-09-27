# Resource Limits

## Execution Limits
- Instruction fuel limit: 10,000,000 steps per script.
- Fuel exhaustion behavior: abort with a Redis error reply.

## Memory Limits
- WASM linear memory: 64 MiB max.
- Max argument buffer size: 8 MiB per call.
- Max reply size: 8 MiB per script result.

## Stack Limits
- Max Lua stack depth: 1024 slots.
- Max recursion depth: 128 calls.
- Max reply nesting depth: 1000 levels, for both script return values and host
  replies decoded by `redis.call`/`redis.pcall`. Deeper (or cyclic) tables fail
  with `ERR reached lua stack limit`.

## Safety Notes
- Limits are enforced consistently across all entrypoints.
- Limits are configurable at host initialization time.
