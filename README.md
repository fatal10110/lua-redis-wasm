# Node.js Host Package

This package loads the Redis-compatible Lua WASM module and provides a binary-safe API.

## Usage

```js
import { LuaWasmEngine } from "redis-lua-wasm";

const engine = await LuaWasmEngine.create({
  host: {
    redisCall(args) {
      // args is an array of Buffer values (binary-safe).
      // return types: null, number/bigint, Buffer/string, array, {ok: Buffer}, {err: Buffer}
      if (args[0].toString("utf8") === "PING") {
        return { ok: Buffer.from("PONG") };
      }
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args) {
      return this.redisCall(args);
    },
    log(level, message) {
      console.log(`[redis.lua] ${level}: ${message.toString("utf8")}`);
    }
  }
});

const result = engine.eval("return 1+1");
console.log(result);
```

### Eval with KEYS/ARGV

```js
const result = engine.evalWithArgs(
  "return {KEYS[1], ARGV[1]}",
  [Buffer.from("key:1")],
  [Buffer.from("value\0binary")]
);
console.log(result);
```

## Host integration guide

- `redis.call` and `redis.pcall` are mapped to host-provided handlers.
- Arguments are binary-safe: every argument arrives as `Buffer`.
- Return values must be Redis-compatible reply shapes (see Reply types).
- For errors:
  - Throw in `redisCall` to return an error from `redis.call`.
  - Return `{ err: Buffer }` from `redisPcall` to emulate `redis.pcall`.
- `redis.log` uses the host logger with a numeric level and `Buffer` message.

## API contract
- `host.redisCall(args: Buffer[])`: called for `redis.call`, must return a ReplyValue or throw.
- `host.redisPcall(args: Buffer[])`: called for `redis.pcall`, errors are returned as `{err: Buffer}`.
- `host.log(level, message)`: receives Redis `redis.log` messages.

## Reply types
- `null`
- `number | bigint`
- `Buffer`
- `{ ok: Buffer }`
- `{ err: Buffer }`
- `ReplyValue[]`

## WASM distribution
- The package bundles the WASM binary by default.
- Override with `wasmPath` or `wasmBytes` if needed.
- The package also bundles the Emscripten module (`redis_lua.mjs`) by default.
- Override with `modulePath` if you need a custom module location.

## Limits
You can supply optional limits at construction time:

```js
const engine = await LuaWasmEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,
    maxMemoryBytes: 64 * 1024 * 1024,
    maxReplyBytes: 2 * 1024 * 1024,
    maxArgBytes: 1 * 1024 * 1024
  }
});
```

| Limit | Meaning | Enforced |
| --- | --- | --- |
| `maxFuel` | Instruction budget for a script | Yes |
| `maxMemoryBytes` | Soft cap for memory growth coordination | Host-coordinated |
| `maxReplyBytes` | Max reply payload size | Yes |
| `maxArgBytes` | Max single argument size | Yes |

Limits are enforced by the WASM runtime where possible and mirrored for host coordination.

## Notes
- `evalWithArgs(script, keys, args)` injects binary-safe `KEYS` and `ARGV`.
- Replies are decoded into JS values:
  - `null`, `number` or `bigint`, `Buffer`, `{ok: Buffer}`, `{err: Buffer}`, or arrays of these.

## Compatibility

| Area | Status |
| --- | --- |
| Redis target | 7.x |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| Debug / REPL helpers | No |
| Redis modules Lua API | Not yet |

## Docs
- `docs/host-interface.md`
- `docs/limits-compat.md`

## Helper utilities
The package exports helper functions for embedding:

```js
import { encodeArgs, decodeReplyBuffer } from "redis-lua-wasm";
```

## Standalone mode
If you only need plain `eval` without `redis.call`, use:

```js
const engine = await LuaWasmEngine.createStandalone({});
```

`redis.call` and `redis.pcall` will return errors in standalone mode.
