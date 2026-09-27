# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

lua-redis-wasm is a WebAssembly-based Redis Lua 5.1 script execution engine for Node.js and browsers. It executes Redis-compatible Lua scripts in JavaScript/TypeScript environments without requiring a live Redis server.

Key features: Redis 7.x Lua 5.1 compatibility by default, Redis 6.2–8.0 / Valkey 8.0–9.0 via compat profiles, binary-safe (null bytes supported), includes standard libraries (cjson, cmsgpack, struct, bit), resource limits via fuel-based instruction counting.

## Common Commands

```bash
# Build
npm run build           # Full build (WASM + TypeScript)
npm run build:ts        # TypeScript only (faster for TS changes)
npm run build:wasm      # WASM only (requires Docker + Emscripten)
npm run smoke           # Native C smoke tests (Docker)

# Test
npm test                # Full test suite (rebuilds WASM first)
npm run test:skip-wasm  # Run tests without rebuilding WASM

# Run a single test file
node --test --test-timeout=60000 --import tsx test/engine.test.ts
```

## Architecture

```
Application → Public API (engine.ts) → Loader (loader.ts) → Emscripten Glue → WASM Module
                                                    ↑
                                              Host callbacks
```

### Layer Responsibilities

- **src/engine.ts** - Core API: `LuaEngine` (evaluation, compile-only check `compile()`, `reset()`/`dispose()`, static `create`/`createStandalone` convenience factories), `LuaWasmModule` (factory), `load()`, compat profile resolution, `LuaWasmEngine` (deprecated alias of `LuaEngine`, to be removed in a future major)
- **src/loader.ts** / **src/loader.browser.ts** / **src/loader-core.ts** - WASM module loading (compiled module cached per process), host import injection
- **src/codec.ts** - Binary encoding/decoding for ABI (reply values, argument arrays)
- **src/helpers.ts** - WASM memory operations, ABI helpers, SHA1
- **src/types.ts** - TypeScript types (`ReplyValue`, `RedisHost`, `EngineLimits`, `CompatProfile`, `CompatOverrides`)
- **wasm/src/runtime.c** - Lua VM initialization, script execution, fuel limiting
- **wasm/src/redis_api.c** - Lua bindings for redis.call/pcall/log/sha1hex/error_reply/status_reply/setresp

### Dual API Design

```typescript
// Modular API (fine-grained control)
const module = await load(options);
const engine = module.create(host);
engine.eval(script);

// Convenience API (simpler)
const engine = await LuaEngine.create({ host, limits });
engine.eval(script);

engine.compile(script); // null, or the compile error eval would give (for SCRIPT LOAD)
engine.reset();   // fresh Lua VM, same limits/compat/props/host
engine.dispose(); // close the VM and drop the WASM instance

// LuaWasmEngine is a deprecated alias of LuaEngine (to be removed in a future major)
```

### Binary Protocol (ABI)

ABI version 4; the full spec is in `docs/abi.md`.

Reply encoding: `[type: u8][length_or_count: u32le][payload]`
- Type tags: 0x00=NULL, 0x01=INTEGER, 0x02=BULK STRING, 0x03=ARRAY, 0x04=STATUS, 0x05=ERROR, 0x06=SCRIPT ERROR (`[line: u32le][flags: u8]`, engine kind/name when flagged, then the message; flag 0x04 marks a compile error), 0x07-0x0c=RESP3 (boolean, double, map, set, big number, verbatim)

Argument encoding: `[count: u32le][len1: u32le][data1][len2: u32le][data2]...`

### Host Interface

Host provides callbacks injected into WASM:
```typescript
type RedisHost = {
  redisCall(args: Buffer[], ctx?: RedisCallContext): ReplyValue;   // Throws on error
  redisPcall(args: Buffer[], ctx?: RedisCallContext): ReplyValue;  // Returns {err: Buffer} on error
  log(level: number, message: Buffer): void;
  onSetResp?(version: 2 | 3): void;                               // Optional
};
```

## Key Patterns

- **Module is one-time use**: After `create()` or `createStandalone()`, the module cannot create another engine (it hands its instance to the engine); the compiled `WebAssembly.Module` is cached, so another `load()` only instantiates
- **Lifecycle**: `reset()`/`dispose()` are refused while a script runs (from a host callback); after `dispose()` every eval/compile/reset throws
- **Binary-safe throughout**: All data flows as Buffers, never strings (except intentional UTF-8 for commands)
- **sret ABI**: `PtrLen`-returning exports/imports take a leading struct-return pointer; the engine writes/reads the 8-byte result there
- **Host imports never throw**: each import catches everything and reports failure via its return value, which C raises as a Lua error; an exception that still escapes WASM marks the engine unusable
- **Host callbacks mutable**: Handlers can be updated dynamically via `handlers` object
- **Standalone mode**: No redis.call/pcall available, for pure Lua computations

## Build Requirements

- Node.js >= 22
- Docker (for WASM build only)
- Clone with submodules: `git clone --recursive` (Lua 5.1 sources in vendor/valkey/deps/lua, from the `vendor/valkey` submodule, pinned to a Valkey release tag)
