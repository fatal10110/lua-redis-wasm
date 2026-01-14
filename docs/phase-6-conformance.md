# Phase 6 — Conformance and Fuzz Testing

## Goals
- Validate Redis 7 compatibility with golden tests.
- Ensure binary safety across inputs and outputs.

## Work items
- Conformance harness:
  - Run same Lua script against Redis 7 and WASM.
  - Capture and compare replies byte-for-byte.
- Golden suite:
  - Build scripts covering Redis APIs and modules.
  - Include edge cases: null bytes, invalid UTF-8, deep arrays.
- Fuzz testing:
  - Fuzz host<->WASM marshalling boundaries.
  - Fuzz module inputs for crashes or mismatches.
- Reporting:
  - Summarize pass/fail and coverage.
  - Track mismatches with repro scripts.

## Artifacts
- `conformance/` scripts and golden outputs.
- `fuzz/` harness and corpus.
- CI test outputs and reports.

## Acceptance criteria
- Conformance suite passes for supported surface.
- Fuzzing finds no crashes or undefined behavior.
