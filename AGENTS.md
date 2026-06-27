# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

lua-redis-wasm is a WebAssembly-based Redis Lua 5.1 script execution engine for Node.js. It executes Redis-compatible Lua scripts in JavaScript/TypeScript environments without requiring a live Redis server.

Key features: Full Redis 7.x Lua 5.1 compatibility, binary-safe (null bytes supported), includes standard libraries (cjson, cmsgpack, struct, bit), resource limits via fuel-based instruction counting.

## Common Commands

```bash
# Build
npm run build           # Full build (WASM + TypeScript)
npm run build:ts        # TypeScript only (faster for TS changes)
npm run build:wasm      # WASM only (requires Docker + Emscripten)

# Test
npm test                # Full test suite (rebuilds WASM first)
npm run test:skip-wasm  # Run tests without rebuilding WASM

# Run a single test file
node --test --import tsx test/engine.test.ts
```

## Architecture

```
Application → Public API (engine.ts) → Loader (loader.ts) → Emscripten Glue → WASM Module
                                                    ↑
                                              Host callbacks
```

### Layer Responsibilities

- **src/engine.ts** - Core API: `LuaWasmEngine` (convenience), `LuaWasmModule` (factory), `LuaEngine` (evaluation)
- **src/loader.ts** - WASM module loading, host import injection
- **src/codec.ts** - Binary encoding/decoding for ABI (reply values, argument arrays)
- **src/helpers.ts** - WASM memory operations, ABI helpers, SHA1
- **src/types.ts** - TypeScript types (`ReplyValue`, `RedisHost`, `EngineLimits`)
- **wasm/src/runtime.c** - Lua VM initialization, script execution, fuel limiting
- **wasm/src/redis_api.c** - Lua bindings for redis.call/pcall/log/sha1hex

### Dual API Design

```typescript
// Modular API (fine-grained control)
const module = await load(options);
const engine = module.create(host);
engine.eval(script);

// Convenience API (simpler)
const engine = await LuaWasmEngine.create({ host, limits });
engine.eval(script);
```

### Binary Protocol (ABI)

Reply encoding: `[type: u8][length_or_count: u32le][payload]`
- Type tags: 0x00=NULL, 0x01=INTEGER, 0x02=BULK STRING, 0x03=ARRAY, 0x04=STATUS, 0x05=ERROR

Argument encoding: `[count: u32le][len1: u32le][data1][len2: u32le][data2]...`

### Host Interface

Host provides callbacks injected into WASM:
```typescript
type RedisHost = {
  redisCall(args: Buffer[]): ReplyValue;   // Throws on error
  redisPcall(args: Buffer[]): ReplyValue;  // Returns {err: Buffer} on error
  log(level: number, message: Buffer): void;
};
```

## Key Patterns

- **Module is one-time use**: After `create()` or `createStandalone()`, the module cannot create another engine
- **Binary-safe throughout**: All data flows as Buffers, never strings (except intentional UTF-8 for commands)
- **ABI dual support**: Engine handles both direct returns and sret calling conventions
- **Host callbacks mutable**: Handlers can be updated dynamically via `handlers` object
- **Standalone mode**: No redis.call/pcall available, for pure Lua computations

## Build Requirements

- Node.js >= 22
- Docker (for WASM build only)
- Clone with submodules: `git clone --recursive` (Lua 5.1 sources in lua/ submodule)
