# lua-redis-wasm

[![npm version](https://img.shields.io/npm/v/lua-redis-wasm.svg)](https://www.npmjs.com/package/lua-redis-wasm)
[![CI](https://github.com/fatal10110/lua-redis-wasm/workflows/ci/badge.svg)](https://github.com/fatal10110/lua-redis-wasm/actions)
[![Node.js Version](https://img.shields.io/node/v/lua-redis-wasm.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A WebAssembly-based Redis Lua 5.1 script engine for Node.js. Execute Redis-compatible Lua scripts in JavaScript/TypeScript environments without a live Redis server.

## Features

- **Redis-compatible Lua 5.1** - Uses the exact Lua version embedded in Redis
- **Binary-safe** - Full support for null bytes in scripts, arguments, and return values
- **Host integration** - Implement `redis.call`, `redis.pcall`, and `redis.log` in JavaScript
- **Resource limits** - Fuel-based instruction limiting, reply size caps, and memory coordination
- **Redis standard libraries** - Includes `cjson`, `cmsgpack`, `struct`, and `bit` modules
- **TypeScript support** - Full type definitions included

## Installation

```bash
npm install lua-redis-wasm
```

**Requirements:** Node.js >= 22

## Quick Start

```typescript
import { LuaWasmEngine } from "redis-lua-wasm";

const engine = await LuaWasmEngine.create({
  host: {
    redisCall(args) {
      const cmd = args[0].toString();
      if (cmd === "PING") return { ok: Buffer.from("PONG") };
      if (cmd === "GET") return Buffer.from("value");
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args) {
      return this.redisCall(args);
    },
    log(level, message) {
      console.log(`[${level}] ${message.toString()}`);
    },
  },
});

// Simple evaluation
const result = engine.eval("return 1 + 1"); // Returns: 2

// With KEYS and ARGV
const data = engine.evalWithArgs(
  "return {KEYS[1], ARGV[1]}",
  [Buffer.from("user:1")],
  [Buffer.from("hello")],
);
```

## API

### LuaWasmEngine.create(options)

Creates a new engine instance with host integration.

```typescript
const engine = await LuaWasmEngine.create({
  host: RedisHost,       // Required: host callbacks
  limits?: EngineLimits, // Optional: resource limits
  wasmPath?: string,     // Optional: custom WASM file path
  wasmBytes?: Uint8Array // Optional: pre-loaded WASM binary
});
```

### LuaWasmEngine.createStandalone(options)

Creates an engine without host integration. `redis.call` and `redis.pcall` return errors.

```typescript
const engine = await LuaWasmEngine.createStandalone({});
engine.eval("return math.sqrt(16)"); // Works
engine.eval("return redis.call('PING')"); // Returns error
```

### engine.eval(script)

Evaluates a Lua script and returns the result.

```typescript
engine.eval("return 'hello'"); // Returns: Buffer.from("hello")
engine.eval("return {1, 2, 3}"); // Returns: [1, 2, 3]
```

### engine.evalWithArgs(script, keys, args)

Evaluates a script with binary-safe `KEYS` and `ARGV` arrays.

```typescript
engine.evalWithArgs(
  "return {KEYS[1], ARGV[1], ARGV[2]}",
  [Buffer.from("key:1")],
  [Buffer.from("arg1"), Buffer.from("arg2\x00with-null")],
);
```

### LuaWasmEngine (Convenience)

Alternative API that combines loading and creation.

#### LuaWasmEngine.create(options)

```typescript
const engine = await LuaWasmEngine.create({ host: myHost });
```

#### LuaWasmEngine.createStandalone(options)

```typescript
const engine = await LuaWasmEngine.createStandalone();
```

## Host Interface

The host must implement three callbacks:

```typescript
type RedisHost = {
  redisCall: (args: Buffer[]) => ReplyValue; // For redis.call()
  redisPcall: (args: Buffer[]) => ReplyValue; // For redis.pcall()
  log: (level: number, message: Buffer) => void; // For redis.log()
};
```

### redisCall

Called when Lua executes `redis.call(...)`. Arguments arrive as `Buffer[]`. Throw an error to return it to Lua.

### redisPcall

Called when Lua executes `redis.pcall(...)`. Return `{ err: Buffer }` instead of throwing to match Redis behavior.

### log

Called when Lua executes `redis.log(level, message)`. Level is a numeric Redis log level.

## Reply Types

Return values are Redis-compatible:

```typescript
type ReplyValue =
  | null // Lua nil
  | number // Integer (safe range)
  | bigint // Integer (64-bit)
  | Buffer // Bulk string
  | { ok: Buffer } // Status reply (+OK)
  | { err: Buffer } // Error reply (-ERR)
  | ReplyValue[]; // Array
```

### Determining the Response Type

Use type guards to inspect what Lua returned:

```typescript
const result = engine.eval(script);

// Check for null (Lua nil)
if (result === null) {
  console.log("Got nil");
}

// Check for integer
else if (typeof result === "number" || typeof result === "bigint") {
  console.log("Got integer:", result);
}

// Check for array (Lua table with sequential keys)
else if (Array.isArray(result)) {
  console.log("Got array with", result.length, "elements");
  for (const item of result) {
    // Each element is also a ReplyValue - handle recursively
  }
}

// Check for status reply ({ok: Buffer}) - e.g. from SET, PING
else if (typeof result === "object" && "ok" in result) {
  console.log("Got status:", result.ok.toString());
}

// Check for error reply ({err: Buffer})
else if (typeof result === "object" && "err" in result) {
  console.log("Got error:", result.err.toString());
}

// Otherwise it's a bulk string (Buffer)
else if (Buffer.isBuffer(result)) {
  console.log("Got bulk string:", result.toString());
}
```

### Lua Type Conversions

This matches Redis Lua behavior:

```typescript
// Lua nil → null
engine.eval("return nil"); // null

// Lua number → number (or bigint for large values)
engine.eval("return 42"); // 42
engine.eval("return 2^62"); // 4611686018427387904n (bigint)

// Lua string → Buffer
engine.eval("return 'hello'"); // Buffer.from("hello")

// Lua table (array) → ReplyValue[]
engine.eval("return {1, 2, 3}"); // [1, 2, 3]
engine.eval("return {'a', 'b'}"); // [Buffer, Buffer]

// Status reply: commands like SET, PING return {ok: "..."}
// In Lua: local resp = redis.call('SET', 'k', 'v') → resp.ok == "OK"
engine.eval("return redis.call('SET', 'k', 'v')"); // { ok: Buffer.from("OK") }
engine.eval("return redis.call('SET', 'k', 'v').ok"); // Buffer.from("OK")

// Error reply: redis.pcall catches errors as {err: "..."}
// In Lua: local resp = redis.pcall('INVALID') → resp.err == "ERR ..."
engine.eval("return redis.pcall('INVALID')"); // { err: Buffer.from("ERR ...") }
```

> **Note**: Status replies (`+OK`) become `{ok: "..."}` tables in Lua, matching real Redis behavior.
> Use `resp.ok` to access the status string.

## Resource Limits

Protect against runaway scripts with configurable limits:

```typescript
const module = await load({
  limits: {
    maxFuel: 10_000_000, // Instruction budget
    maxMemoryBytes: 64 * 1024 * 1024, // Memory cap (host-coordinated)
    maxReplyBytes: 2 * 1024 * 1024, // Max reply size
    maxArgBytes: 1 * 1024 * 1024, // Max single argument size
  },
});
const engine = module.create(host);
```

| Limit            | Description                  | Enforcement      |
| ---------------- | ---------------------------- | ---------------- |
| `maxFuel`        | Instruction count budget     | WASM runtime     |
| `maxMemoryBytes` | Memory growth cap            | Host-coordinated |
| `maxReplyBytes`  | Maximum reply payload size   | WASM runtime     |
| `maxArgBytes`    | Maximum single argument size | WASM runtime     |

## Included Lua Libraries

The engine includes Redis-standard Lua modules:

- **cjson** - JSON encoding/decoding
- **cmsgpack** - MessagePack serialization
- **struct** - Binary data packing/unpacking
- **bit** - Bitwise operations

Plus standard Lua 5.1 libraries: `base`, `table`, `string`, `math`.

## Use Cases

- **Testing** - Unit test Redis Lua scripts without a Redis server
- **Sandboxing** - Execute untrusted Lua with resource limits
- **Development** - Rapid iteration on Lua scripts locally
- **Embedding** - Add Redis-compatible scripting to Node.js applications

## Compatibility

| Feature                         | Status  |
| ------------------------------- | ------- |
| Redis version target            | 7.x     |
| Lua version                     | 5.1     |
| Binary-safe strings             | Yes     |
| `redis.call` / `redis.pcall`    | Yes     |
| `redis.log`                     | Yes     |
| `redis.sha1hex`                 | Yes     |
| Standard Lua libraries          | Yes     |
| Redis Lua modules (cjson, etc.) | Yes     |
| Debug / REPL helpers            | No      |
| Redis Modules API               | Not yet |

## Building from Source

```bash
# Build everything (requires Emscripten via Docker)
npm run build

# Build steps individually
npm run build:wasm  # Compile C to WASM
npm run build:ts    # Compile TypeScript

# Run tests
npm test
npm run test:skip-wasm  # Skip WASM rebuild
```

## Documentation

- [Host Interface Contract](docs/host-interface.md)
- [Binary ABI Specification](docs/abi.md)
- [Limits and Compatibility](docs/limits-compat.md)

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- How to report bugs
- How to suggest enhancements
- Development setup
- Pull request process
- Coding standards

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## Security

Security is important to us. If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) for responsible disclosure.

For general security considerations when using lua-redis-wasm, see the [Security Guide](SECURITY.md#security-considerations).

## Support

- **Issues**: [GitHub Issues](https://github.com/fatal10110/lua-redis-wasm/issues)
- **Discussions**: [GitHub Discussions](https://github.com/fatal10110/lua-redis-wasm/discussions)
- **Documentation**: [docs/](docs/)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each release.

## License

This package is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

This project includes third-party code, all under the MIT License:

- **Lua 5.1** - Copyright (C) 1994-2012 Lua.org, PUC-Rio
- **lua_cjson** - Copyright (C) 2010-2012 Mark Pulford
- **lua_cmsgpack** - Copyright (C) 2012 Salvatore Sanfilippo
- **lua_struct** - Copyright (C) 2010-2018 Lua.org, PUC-Rio
- **lua_bit** - Copyright (C) 2008-2012 Mike Pall

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full license texts.

## Acknowledgments

- Redis team for the Lua integration design
- Emscripten project for WebAssembly tooling
- Contributors and maintainers of the included Lua libraries
