# Phase 4 — Redis Module Parity

## Goals
- Provide Redis-compatible Lua modules: cjson, cmsgpack, struct, bit.
- Match Redis 7 defaults and error messages.

## Work items
- `cjson`:
  - Port Redis 7 behavior and defaults.
  - Implement config flags and edge cases.
  - Ensure binary-safe encoding and decoding.
- `cmsgpack`:
  - Implement Redis extension types.
  - Match Redis error strings for invalid input.
  - Preserve binary-safe payloads.
- `struct`:
  - Implement pack/unpack behavior to Redis spec.
  - Validate alignment and endianness rules.
- `bit`:
  - Provide bitwise operations compatible with Redis 7.
- Module loading:
  - Preload modules into Lua state.
  - Ensure module globals are isolated.

## Artifacts
- Module source in `wasm/src/modules/` or `modules/`.
- Module tests in `host/test/` or `wasm/src/tests/`.

## Acceptance criteria
- Modules match Redis 7 output for test vectors.
- All module inputs/outputs are binary-safe.
