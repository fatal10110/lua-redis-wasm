# Redis Lua WASM Plan (Redis 7 + Lua 5.1, Node.js host)

## Phases

### Phase 0 — Definition and constraints
- Confirm Redis 7 Lua surface area to support (exclude debug/repl helpers).
- Enumerate module parity list: cjson, cmsgpack, struct, bit.
- Define sandbox rules (no IO/OS, deterministic behavior, no randomness unless host supplied).
- Decide resource limits (memory, stack, instruction/fuel).
- Deliverables: API spec doc, module list doc, constraints matrix.

### Phase 1 — Architecture + ABI design
- Choose Lua 5.1 source base and WASM toolchain (Emscripten or WASI with custom syscalls).
- Design binary-safe ABI for Node.js host:
  - All strings/arrays as ptr+len in linear memory.
  - Reply encoding (bulk, int, array, status, error, null).
  - Error/status reply construction from Lua.
- Define host import table (redis.call/pcall, log, sha1hex, timeouts).
- Deliverables: ABI header/spec, memory layout doc, reply type enum.

### Phase 2 — Core runtime implementation
- Compile Lua 5.1 to WASM with sandboxed stdlib (no file/OS/time).
- Implement memory alloc/free API for host-allocated buffers.
- Add instruction “fuel” counter or step limiter to prevent runaway scripts.
- Expose entrypoints: load script, eval script, reset VM.
- Deliverables: WASM build pipeline, minimal Lua VM in WASM, smoke tests.

### Phase 3 — Redis API bindings
- Implement Lua redis table with:
  - redis.call, redis.pcall (host import)
  - redis.log, redis.sha1hex
  - redis.error_reply, redis.status_reply
  - redis.setresp (RESP2/RESP3 mapping)
- Ensure return mapping matches Redis 7 (Lua tables vs. arrays, nil handling).
- Deliverables: Redis bindings in C/Lua, correctness tests.

### Phase 4 — Redis module parity
- Port/implement Redis-compatible modules:
  - cjson (same defaults, error strings, and config flags).
  - cmsgpack (including Redis extension types).
  - struct and bit with Redis 7 semantics.
- Validate binary safety on module outputs.
- Deliverables: modules compiled into WASM, module tests.

### Phase 5 — Node.js host package
- Node runtime wrapper:
  - Load WASM, manage memory, encode/decode binary-safe args/replies.
  - Provide JS API mirroring Redis Lua eval + function interface.
- TypeScript types + minimal docs.
- Deliverables: npm package skeleton, Node host bindings, unit tests.

### Phase 6 — Conformance + fuzz testing
- Build a Redis 7 golden test suite:
  - Run same Lua scripts in Redis 7 and compare results byte-for-byte.
  - Edge cases: null bytes, invalid UTF-8, large payloads, deep arrays.
- Fuzz marshalling and module inputs to verify binary safety.
- Deliverables: conformance harness, fuzz tests, coverage report.

### Phase 7 — Packaging + CI
- Reproducible WASM builds (pinned toolchain).
- CI pipeline: build, test, conformance.
- Publish artifacts + versioning strategy.
- Deliverables: CI config, release docs, versioned package.

## Proposed repo layout
- docs/
- docs/compat.md (Redis 7 API + module list + exclusions)
- docs/abi.md (binary-safe ABI + reply encoding)
- docs/limits.md (memory/stack/fuel policy)
- lua/ (Lua 5.1 source/vendor + patches)
- lua/patches/ (Redis-specific patches if any)
- wasm/
- wasm/build/ (build scripts/toolchain configs)
- wasm/src/ (C glue for redis table, modules, host imports)
- wasm/include/ (ABI headers)
- modules/ (if separated for clarity)
- host/ (Node.js package)
- host/src/ (TS/JS bindings, memory marshalling)
- host/test/
- conformance/
- conformance/scripts/ (Lua scripts used in Redis 7)
- conformance/golden/ (byte-for-byte expected outputs)
- fuzz/
- fuzz/cases/
- ci/
- ci/workflows/ (CI configs)
- README.md

## Milestones + tasks

### M0 — Repo scaffolding
- Create directories listed above.
- Add README.md with scope and quickstart.
- Add docs/compat.md and docs/abi.md skeletons.

### M1 — ABI + architecture
- Fill docs/abi.md with:
  - memory layout, ptr+len rules, reply encoding.
  - host import signatures.
- Fill docs/limits.md with fuel + memory policy.
- Define Node host API surface (JS/TS signature).

### M2 — Core Lua 5.1 WASM
- Vendor Lua 5.1 into lua/.
- Build script in wasm/build/ for WASM output.
- Minimal entrypoints: init, eval, reset, alloc/free.
- Smoke test in wasm/src/.

### M3 — Redis API bindings
- Implement redis table glue in wasm/src/redis_api.c.
- redis.call/pcall, redis.log, redis.sha1hex, redis.error_reply, redis.status_reply, redis.setresp.
- Ensure return conversion matches Redis 7 rules.

### M4 — Module parity
- Add cjson, cmsgpack, struct, bit modules.
- Ensure config flags and error messages match Redis 7.
- Add unit tests under wasm/src/tests/ or host/test/.

### M5 — Node.js host package
- Implement binary-safe marshalling in host/src/memory.ts.
- Implement reply decoding in host/src/reply.ts.
- Public API in host/src/index.ts.
- Basic TS types in host/src/types.ts.

### M6 — Conformance suite
- Script runner that can run same Lua in Redis 7 and in WASM.
- Populate conformance/scripts/ and conformance/golden/.
- Byte-for-byte comparison utility.

### M7 — Fuzzing
- Build fuzz harness for ABI marshalling (buffers, nested arrays).
- Add corpus in fuzz/cases/.

### M8 — CI + release
- CI build/test workflow in ci/workflows/.
- Add packaging scripts and versioning.
- Document release steps in docs/release.md.
