# Phase 7 — Packaging and CI

## Goals
- Provide reproducible builds and automated validation.
- Prepare npm package distribution.

## Work items
- Build reproducibility:
  - Pin toolchain versions.
  - Document build steps and environment.
- CI pipeline:
  - Build WASM artifacts.
  - Run unit tests, conformance, and fuzz suites.
- Packaging:
  - Define npm package layout.
  - Ship WASM artifacts and JS bindings.
  - Versioning and release process.
- Documentation:
  - README usage examples.
  - Release guide in `docs/release.md`.

## Artifacts
- CI workflows in `ci/workflows/`.
- `docs/release.md` with release steps.
- Published npm package.

## Acceptance criteria
- CI passes on all supported platforms.
- Release process is documented and repeatable.
