# Phase 1 — Architecture and ABI Design

## Goals
- Define a binary-safe ABI between Node.js and WASM.
- Specify memory layout and reply encoding.
- Choose toolchain and runtime integration approach.

## Work items
- Choose toolchain and build target:
  - Decide between Emscripten and WASI.
  - Document required compiler flags and linker settings.
- Define ABI and memory layout:
  - Linear memory regions for argument buffers.
  - Pointer + length for all data.
  - Alignment rules and ownership model.
- Define reply encoding:
  - Enum for reply types (bulk, int, array, status, error, null).
  - Encoding for nested arrays and nil values.
  - Error/status payload format (binary-safe).
- Define host import interface:
  - `redis.call` / `redis.pcall` signatures.
  - `redis.log`, `redis.sha1hex` interface.
  - Optional host hooks: timeouts, metrics.
- Define WASM exports:
  - `init`, `reset`, `eval`, `alloc`, `free`.
  - Optional `load` for precompiled bytecode.
- Define Node host API surface:
  - Input types (Buffer/Uint8Array).
  - Output mapping to reply structures.

## Artifacts
- `docs/abi.md` with full ABI spec.
- `wasm/include/abi.h` with enums and signatures.
- Node API draft in `docs/abi.md` or `docs/compat.md`.

## Acceptance criteria
- ABI spec is complete and binary-safe.
- Reply encoding supports all Redis 7 reply forms.
- Toolchain choice is recorded with rationale.
