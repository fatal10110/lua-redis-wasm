# redis-lua-wasm

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
npm install redis-lua-wasm
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
    }
  }
});

// Simple evaluation
const result = engine.eval("return 1 + 1"); // Returns: 2

// With KEYS and ARGV
const data = engine.evalWithArgs(
  "return {KEYS[1], ARGV[1]}",
  [Buffer.from("user:1")],
  [Buffer.from("hello")]
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
  [Buffer.from("arg1"), Buffer.from("arg2\x00with-null")]
);
```

## Host Interface

The host must implement three callbacks:

```typescript
type RedisHost = {
  redisCall: (args: Buffer[]) => ReplyValue;  // For redis.call()
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

Return values must be Redis-compatible:

```typescript
type ReplyValue =
  | null                // Lua nil
  | number              // Integer (safe range)
  | bigint              // Integer (64-bit)
  | Buffer              // Bulk string
  | { ok: Buffer }      // Status reply
  | { err: Buffer }     // Error reply
  | ReplyValue[];       // Array
```

## Resource Limits

Protect against runaway scripts with configurable limits:

```typescript
const engine = await LuaWasmEngine.create({
  host,
  limits: {
    maxFuel: 10_000_000,              // Instruction budget
    maxMemoryBytes: 64 * 1024 * 1024, // Memory cap (host-coordinated)
    maxReplyBytes: 2 * 1024 * 1024,   // Max reply size
    maxArgBytes: 1 * 1024 * 1024      // Max single argument size
  }
});
```

| Limit | Description | Enforcement |
|-------|-------------|-------------|
| `maxFuel` | Instruction count budget | WASM runtime |
| `maxMemoryBytes` | Memory growth cap | Host-coordinated |
| `maxReplyBytes` | Maximum reply payload size | WASM runtime |
| `maxArgBytes` | Maximum single argument size | WASM runtime |

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

| Feature | Status |
|---------|--------|
| Redis version target | 7.x |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| `redis.log` | Yes |
| `redis.sha1hex` | Yes |
| Standard Lua libraries | Yes |
| Redis Lua modules (cjson, etc.) | Yes |
| Debug / REPL helpers | No |
| Redis Modules API | Not yet |

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

## License

This package is licensed under the **MIT License**.

### Third-Party Licenses

This project includes third-party code, all under the MIT License:

- **Lua 5.1** - Copyright (C) 1994-2012 Lua.org, PUC-Rio
- **lua_cjson** - Copyright (C) 2010-2012 Mark Pulford
- **lua_cmsgpack** - Copyright (C) 2012 Salvatore Sanfilippo
- **lua_struct** - Copyright (C) 2010-2018 Lua.org, PUC-Rio
- **lua_bit** - Copyright (C) 2008-2012 Mike Pall

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full license texts.
