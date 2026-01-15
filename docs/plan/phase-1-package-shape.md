# Phase 1 — Package Shape and API Contract

## Goal
Define a stable, easy-to-use public API for embedding the Lua WASM engine inside a Redis server implementation.

## Scope
- Public TypeScript API shape.
- Reply type model and error semantics.
- Embedding contract for `redis.call` and `redis.pcall`.

## Tasks
- Define public entry points:
  - `createEngine(options)` or `LuaWasmEngine.create(options)`.
  - `engine.eval(script, keys?, args?)`.
  - `engine.reset()` and optional `engine.dispose()`.
- Decide reply type surface:
  - Union type for replies: null, number, bigint, Buffer, {ok}, {err}, arrays.
  - Optional wrapper class for response metadata.
- Define handler contract:
  - `redisCall(args: Buffer[]) => ReplyValue`.
  - `redisPcall(args: Buffer[]) => ReplyValue`.
  - Define error mapping semantics (pcall returns `{err}`, call throws/returns error reply).
- Document binary-safety guarantees in API docs.

## Deliverables
- `host/src/types.ts` with exported types.
- `host/src/index.ts` updated to use exported types.
- `host/README.md` with API overview and embedding contract.

## Acceptance criteria
- API is clear and stable enough for a Redis server integration.
- Reply type semantics are explicitly documented.
