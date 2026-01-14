# Phase 5 — Node.js Host Package

## Goals
- Implement a binary-safe Node.js runtime wrapper.
- Provide a stable JS/TS API for script evaluation.

## Work items
- WASM loader:
  - Load and instantiate WASM with imports.
  - Manage shared memory and lifecycle.
- Binary-safe marshalling:
  - Encode args using `Uint8Array`/`Buffer`.
  - Implement ptr+len writes into WASM memory.
  - Prevent implicit string conversion.
- Reply decoding:
  - Parse reply encoding into JS structures.
  - Preserve binary data as Buffer/Uint8Array.
- Public API:
  - `eval(script, keys, args)` or similar.
  - `load(script)` for cached functions.
  - Optional configuration for limits.
- TypeScript types and docs:
  - Define reply type unions.
  - Provide minimal usage examples.

## Artifacts
- `host/src/` with loader, memory, reply decoder.
- `host/test/` unit tests.
- Package metadata for npm.

## Acceptance criteria
- Node API returns binary-safe data for all reply types.
- WASM lifecycle management avoids memory leaks.
