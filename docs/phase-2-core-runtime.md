# Phase 2 — Core Lua 5.1 WASM Runtime

## Goals
- Compile Lua 5.1 to WASM with deterministic sandbox.
- Provide minimal VM lifecycle and entrypoints.
- Enforce resource limits.

## Work items
- Vendor Lua 5.1 into `lua/`:
  - Import pristine 5.1 source.
  - Apply minimal patches required for WASM.
- Build pipeline:
  - Create build scripts in `wasm/build/`.
  - Produce `.wasm` and metadata artifacts.
- VM lifecycle:
  - Implement `init` to set up Lua state and preload modules.
  - Implement `reset` to clear state between scripts.
- Memory management:
  - Expose `alloc` and `free` for host buffers.
  - Ensure no JS string conversion in host path.
- Fuel/step limits:
  - Add instruction counter hook.
  - Define behavior on limit breach (error reply).
- Sandbox:
  - Disable file/OS/time/random libraries.
  - Ensure no hidden nondeterminism.

## Artifacts
- WASM build outputs in `wasm/build/`.
- `wasm/src/runtime.c` with VM lifecycle.
- Smoke tests validating init/eval/reset.

## Acceptance criteria
- WASM runtime runs Lua 5.1 scripts deterministically.
- Resource limits are enforced and testable.
- Minimal script eval works with binary-safe input.
