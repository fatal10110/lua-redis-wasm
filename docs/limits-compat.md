# Limits and Compatibility

## Limits

Limits are optional and all enforced by the WASM runtime (see
[limits.md](limits.md) for details).

| Limit | Meaning | Default |
| --- | --- | --- |
| `maxFuel` | Instruction budget for a script | 10,000,000 (0 = default) |
| `maxReplyBytes` | Max encoded reply size, checked while encoding | no limit |
| `maxArgBytes` | Max encoded KEYS + ARGV size | no limit |

Example:

```js
const engine = await LuaEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,
    maxReplyBytes: 2 * 1024 * 1024,
    maxArgBytes: 1 * 1024 * 1024
  }
});
```

## Compatibility

| Area | Status |
| --- | --- |
| Redis target | 7.x by default; Redis 6.2–8.0 and Valkey 8.0–9.0 via `profile` (see [compat.md](compat.md)) |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| RESP3 conversions / `redis.setresp(3)` | Yes; RESP3 push is not a Lua return type |
| Debug / REPL helpers | No |
| Redis modules Lua API | Not yet |
