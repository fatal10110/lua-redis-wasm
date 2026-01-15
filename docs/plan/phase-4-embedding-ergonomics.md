# Phase 4 — Embedding Ergonomics

## Goal
Provide helpers and configuration options for Redis server integration.

## Scope
- Convenience helpers.
- Limits and configuration surface.
- Error mapping alignment.

## Tasks
- Add helper functions:
  - `encodeArgs(keys, args)`.
  - `decodeReplyBuffer(buffer)`.
- Expose limit configuration:
  - fuel limit, memory limit (even if wired later).
- Add logging hooks:
  - map `redis.log` to user-provided logger.
- Define compatibility options:
  - RESP2/RESP3 mapping toggle if needed.

## Deliverables
- Updated `host/src/index.ts` with helpers and options.
- `host/src/types.ts` with options types.
- Example integration code in `host/README.md`.

## Acceptance criteria
- Embedding requires minimal glue code in a Redis server.
- Binary-safe paths are the default.
