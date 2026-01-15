# Release Process

## Package release checklist
- Build WASM artifacts if required by the host package.
- Run host tests: `npm run test` in `host/`.
- Update `host/CHANGELOG.md`.
- Publish from `host/` with `npm publish`.

## Notes
- This package does not bundle the WASM binary by default; downstream apps must provide it.
