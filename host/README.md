# Node.js Host Package

This package loads the Redis-compatible Lua WASM module and provides a binary-safe API.

## Usage

```js
import { LuaWasmEngine } from "redis-lua-wasm";

const engine = await LuaWasmEngine.create({
  wasmPath: "wasm/build/redis_lua.wasm",
  redisCall(args) {
    // args is an array of Buffer values (binary-safe).
    // return types: null, number, Buffer/string, array, {ok: Buffer}, {err: Buffer}
    if (args[0].toString("utf8") === "PING") {
      return { ok: Buffer.from("PONG") };
    }
    return { err: Buffer.from("ERR unknown command") };
  }
});

const result = engine.eval("return 1+1");
console.log(result);
```

## Notes
- `evalWithArgs(script, keys, args)` injects binary-safe `KEYS` and `ARGV`.
- Replies are decoded into JS values:
  - `null`, `number` or `bigint`, `Buffer`, `{ok: Buffer}`, `{err: Buffer}`, or arrays of these.
