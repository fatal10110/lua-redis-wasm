# Phase 3 — Build and Distribution

## Goal
Make the package easy to consume by downstream Redis server implementations.

## Scope
- Build scripts and publish-ready artifacts.
- WASM asset distribution strategy.

## Tasks
- Decide WASM distribution strategy:
  - Option A: ship `wasm/build/redis_lua.wasm` as a packaged asset.
  - Option B: require host to supply `wasmBytes` or `wasmPath`.
- Add `prepack` or `prepare` script to build before publish.
- Ensure `files` whitelist includes required assets.
- Add versioning policy (SemVer) and changelog.

## Deliverables
- Updated `host/package.json` with `files` and `prepare`/`prepack`.
- `CHANGELOG.md` at repo root or in `host/`.
- Packaging notes in `host/README.md`.

## Acceptance criteria
- A fresh `npm pack` includes all required JS, types, and WASM assets.
- Consumers can load WASM without manual file copying.
