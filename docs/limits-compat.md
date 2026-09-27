# Limits and Compatibility

## Limits

Limits are optional and all enforced by the WASM runtime (see the README's
"Resource Limits" section for details).

| Limit | Meaning | Enforced |
| --- | --- | --- |
| `maxFuel` | Instruction budget for a script | Yes |
| `maxMemoryBytes` | Cap on the Lua state's memory (Lua objects, garbage not yet collected, cmsgpack buffers) | Yes, while a script runs |
| `maxReplyBytes` | Max encoded reply size, checked while encoding | Yes |
| `maxArgBytes` | Max encoded KEYS + ARGV size | Yes |

Example:

```js
const engine = await LuaWasmEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,
    maxMemoryBytes: 32 * 1024 * 1024,
    maxReplyBytes: 2 * 1024 * 1024,
    maxArgBytes: 1 * 1024 * 1024
  }
});
```

## Compatibility

| Area | Status |
| --- | --- |
| Redis target | 7.x |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| RESP3 conversions / `redis.setresp(3)` | Yes; RESP3 push is not a Lua return type |
| Debug / REPL helpers | No |
| Redis modules Lua API | Not yet |
