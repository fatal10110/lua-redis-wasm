# Phase 5 — Testing and Compatibility

## Goal
Validate that the package behaves like Redis 7 Lua scripting for supported APIs.

## Scope
- Host package unit tests.
- Binary-safety tests.
- Conformance scaffolding.

## Tasks
- Add host unit tests:
  - `eval`, `evalWithArgs`, `redis.call`, `redis.pcall`.
  - Binary data path tests (null bytes).
- Add conformance test harness:
  - Run reference scripts against Redis 7.
  - Compare replies byte-for-byte.
- Add error mapping tests:
  - Ensure error strings and status replies match Redis.

## Deliverables
- `host/src/test/` tests.
- `conformance/` harness and scripts.
- CI steps to run host tests.

## Acceptance criteria
- Host tests pass on CI.
- Conformance suite passes for supported surface.
