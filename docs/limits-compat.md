# Limits and Compatibility

## Limits

Limits are optional and enforced by the WASM runtime where possible.

| Limit | Meaning | Enforced |
| --- | --- | --- |
| `maxFuel` | Instruction budget for a script | Yes |
| `maxMemoryBytes` | Soft cap for memory growth coordination | Host-coordinated |
| `maxReplyBytes` | Max reply payload size | Yes |
| `maxArgBytes` | Max single argument size | Yes |

Example:

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

## Compatibility

| Area | Status |
| --- | --- |
| Redis target | 7.x |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| Debug / REPL helpers | No |
| Redis modules Lua API | Not yet |

