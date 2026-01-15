# Phase 2 — TypeScript Packaging Essentials

## Goal
Convert the host code into a proper TypeScript package with clean build outputs and typings.

## Scope
- TS build config and module format.
- Public exports and type declarations.

## Tasks
- Create or update `host/tsconfig.json`:
  - `declaration`, `declarationMap`, `sourceMap` enabled.
  - `target` set to ES2020+.
- Add `host/src/types.ts` and export from `host/src/index.ts`.
- Update `host/package.json`:
  - `main`, `types`, and `exports` fields for `dist/`.
  - `build` script to run `tsc`.
  - `files` whitelist to include `dist/` and any WASM assets.
- Ensure ESM output and Node >= 16 compatibility.

## Deliverables
- `host/tsconfig.json` with proper build outputs.
- `host/src/types.ts` and updated `index.ts` exports.
- `host/package.json` with `exports` and `files` fields.

## Acceptance criteria
- `npm run build` produces `dist/index.js` and `dist/index.d.ts`.
- Consumers can import types directly from the package.
