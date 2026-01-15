# Node.js Host Package

This package loads the Redis-compatible Lua WASM module and provides a binary-safe API.

## Usage

```js
import { LuaWasmEngine } from "redis-lua-wasm";

const engine = await LuaWasmEngine.create({
  wasmPath: "wasm/build/redis_lua.wasm",
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

## Notes
- `evalWithArgs(script, keys, args)` injects binary-safe `KEYS` and `ARGV`.
- Replies are decoded into JS values:
  - `null`, `number` or `bigint`, `Buffer`, `{ok: Buffer}`, `{err: Buffer}`, or arrays of these.

## Standalone mode
If you only need plain `eval` without `redis.call`, use:\n\n```js\nconst engine = await LuaWasmEngine.createStandalone({\n  wasmPath: \"wasm/build/redis_lua.wasm\"\n});\n```\n\n`redis.call` and `redis.pcall` will return errors in standalone mode.
