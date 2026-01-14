# Phase 0 — Definition and Constraints

## Goals
- Lock scope for Redis 7 Lua API coverage and exclusions.
- Define deterministic sandbox rules and resource limits.
- Establish non-goals and compatibility boundaries.

## Work items
- Inventory Redis 7 Lua API surface to support:
  - Document required `redis.*` functions.
  - Confirm supported reply types and semantics.
  - Note any Redis 7 behavior changes vs earlier versions.
- Confirm exclusion list:
  - Explicitly exclude debug and repl helpers.
  - Document any excluded modules or APIs.
- Define sandbox constraints:
  - No file/OS/network/time access.
  - No randomness unless host-supplied.
  - Deterministic execution requirements.
- Define limits:
  - Max memory for WASM module.
  - Max stack depth.
  - Instruction fuel limit and behavior on exhaustion.
  - Max reply sizes and array lengths.
- Establish compatibility test criteria:
  - Byte-for-byte equivalence with Redis 7 for supported API.
  - Defined error strings for module failures.

## Artifacts
- `docs/compat.md` updated with supported APIs and exclusions.
- `docs/limits.md` updated with numeric limits and rationale.
- Decision log with final scope choices.

## Acceptance criteria
- Compatibility scope is explicitly documented and approved.
- Limits are specified and justified.
- Clear list of exclusions to avoid scope creep.
