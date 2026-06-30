# Host-injected `redis.*` props Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the host inject constant fields and simple stub functions onto the `redis` table via a new `redisProps` option, instead of hardcoding helpers in C.

**Architecture:** TypeScript encodes `redisProps` into a typed binary blob. A new `host_redis_props` WASM import delivers the blob; C decodes it and sets fields/stub-closures directly on the `redis` table during `init`/`reset`, before globals protection locks the table. The package also creates the `server = redis` alias internally.

**Tech Stack:** TypeScript (node:test), C (Lua 5.1 C API), Emscripten/WASM.

## Global Constraints

- Node.js >= 22.
- Binary-safe throughout: data flows as Buffers; prop names pushed as Lua lstrings (no null-termination assumptions).
- Wire format is little-endian (WASM is LE).
- `REDIS_LUA_WASM_ABI_VERSION` stays `0` (change is additive — one new import, no layout change to existing imports/exports).
- WASM rebuild requires Docker + Emscripten: `npm run build:wasm`. TS-only tests run via `npm run test:skip-wasm`.
- Follow existing file patterns; do not restructure unrelated code.

---

### Task 1: TypeScript types + `encodeRedisProps`

**Files:**
- Modify: `src/types.ts` (add `RedisProp`, `RedisProps`, `LoadOptions.redisProps`)
- Modify: `src/codec.ts` (add prop tag constants + `encodeRedisProps`)
- Test: `test/codec.test.ts` (append cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RedisProp = { value: string | number | boolean } | { returns: string | number | boolean | null }`
  - `type RedisProps = Record<string, RedisProp>`
  - `LoadOptions.redisProps?: RedisProps`
  - `encodeRedisProps(props: RedisProps | undefined): Buffer` — exported from `src/codec.ts`.
  - Wire constants (module-private to codec): `PROP_KIND_FIELD=0`, `PROP_KIND_STUB=1`, `PROP_VTYPE_NONE=0`, `PROP_VTYPE_BOOL=1`, `PROP_VTYPE_NUMBER=2`, `PROP_VTYPE_STRING=3`.

- [ ] **Step 1: Add the types to `src/types.ts`**

Add after the `RedisHost` type (around line 173):

```typescript
/**
 * A single host-injected `redis.*` property.
 *
 * - `{ value }`  -> `redis[name] = value` (a plain field).
 * - `{ returns }` -> `redis[name] = function(...) return <returns> end`. The stub
 *   ignores all arguments. `returns: null` makes it return nothing (a noop, e.g.
 *   `set_repl`).
 */
export type RedisProp =
  | { value: string | number | boolean }
  | { returns: string | number | boolean | null };

/**
 * Map of `redis.*` member name -> prop. Injected onto the `redis` table at engine
 * init, before globals protection locks it. The package ships none of these by
 * default (blank slate); the host supplies what it needs.
 */
export type RedisProps = Record<string, RedisProp>;
```

Then add `redisProps` to `LoadOptions` (inside the `LoadOptions` type, after `limits`):

```typescript
  /** Optional host-injected `redis.*` props (constants and simple stubs). */
  redisProps?: RedisProps;
```

- [ ] **Step 2: Write the failing tests in `test/codec.test.ts`**

First check the file's existing imports and add `encodeRedisProps` to the import from `../src/codec.ts`, and add a `RedisProps` import from `../src/types.ts` if types are referenced. Append this test block:

```typescript
describe("encodeRedisProps", () => {
  it("encodes empty/undefined as a zero-count blob", () => {
    const a = encodeRedisProps(undefined);
    const b = encodeRedisProps({});
    assert.equal(a.length, 4);
    assert.equal(a.readUInt32LE(0), 0);
    assert.deepEqual([...a], [...b]);
  });

  it("encodes a string field", () => {
    const buf = encodeRedisProps({ REDIS_VERSION: { value: "7.4.0" } });
    assert.equal(buf.readUInt32LE(0), 1); // count
    let off = 4;
    assert.equal(buf.readUInt32LE(off), 13); // name len ("REDIS_VERSION")
    off += 4;
    assert.equal(buf.subarray(off, off + 13).toString(), "REDIS_VERSION");
    off += 13;
    assert.equal(buf[off++], 0); // kind = field
    assert.equal(buf[off++], 3); // vtype = string
    assert.equal(buf.readUInt32LE(off), 5); // value len
    off += 4;
    assert.equal(buf.subarray(off, off + 5).toString(), "7.4.0");
  });

  it("encodes a number field as f64 le", () => {
    const buf = encodeRedisProps({ N: { value: 0x070400 } });
    // count(4) + nameLen(4) + "N"(1) + kind(1) + vtype(1) + f64(8)
    assert.equal(buf.length, 4 + 4 + 1 + 1 + 1 + 8);
    const vstart = 4 + 4 + 1 + 1 + 1;
    assert.equal(buf[4 + 4 + 1], 0); // kind field
    assert.equal(buf[4 + 4 + 1 + 1], 2); // vtype number
    assert.equal(buf.readDoubleLE(vstart), 0x070400);
  });

  it("encodes a boolean field", () => {
    const buf = encodeRedisProps({ T: { value: true } });
    const k = 4 + 4 + 1;
    assert.equal(buf[k], 0); // kind field
    assert.equal(buf[k + 1], 1); // vtype bool
    assert.equal(buf[k + 2], 1); // true
  });

  it("encodes a stub returning a constant", () => {
    const buf = encodeRedisProps({ replicate_commands: { returns: true } });
    const k = 4 + 4 + "replicate_commands".length;
    assert.equal(buf[k], 1); // kind stub
    assert.equal(buf[k + 1], 1); // vtype bool
    assert.equal(buf[k + 2], 1); // true
  });

  it("encodes a noop stub (returns null) with vtype none and no payload", () => {
    const buf = encodeRedisProps({ set_repl: { returns: null } });
    const k = 4 + 4 + "set_repl".length;
    assert.equal(buf[k], 1); // kind stub
    assert.equal(buf[k + 1], 0); // vtype none
    assert.equal(buf.length, k + 2); // no payload after vtype
  });

  it("throws when an entry has neither value nor returns", () => {
    assert.throws(() => encodeRedisProps({ X: {} as never }), TypeError);
  });

  it("throws when an entry has both value and returns", () => {
    assert.throws(
      () => encodeRedisProps({ X: { value: 1, returns: 2 } as never }),
      TypeError,
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:skip-wasm -- test/codec.test.ts`
Expected: FAIL — `encodeRedisProps is not a function` (or import error).

- [ ] **Step 4: Implement `encodeRedisProps` in `src/codec.ts`**

Add the import of the prop types near the top (the file already imports from `./types.js`):

```typescript
import type { ReplyValue, RedisProps } from "./types.js";
```

Add the constants near the other reply-tag constants:

```typescript
/** redisProps wire kinds. */
const PROP_KIND_FIELD = 0;
const PROP_KIND_STUB = 1;

/** redisProps wire value types. */
const PROP_VTYPE_NONE = 0;
const PROP_VTYPE_BOOL = 1;
const PROP_VTYPE_NUMBER = 2;
const PROP_VTYPE_STRING = 3;
```

Add the encoder (place it after `encodeArgArray`):

```typescript
/**
 * Encodes host-injected `redis.*` props into the typed blob consumed by the WASM
 * `host_redis_props` import.
 *
 * Wire format (little-endian):
 * ```
 * [count: u32]
 * per entry:
 *   [name_len: u32][name bytes]
 *   [kind: u8]    // 0 = field, 1 = stub function
 *   [vtype: u8]   // 0 = none(nil), 1 = bool, 2 = number(f64), 3 = string
 *   [payload]     // bool: u8 | number: f64le | string: u32 len + bytes | none: (empty)
 * ```
 *
 * @throws TypeError if an entry does not have exactly one of `value` / `returns`.
 */
export function encodeRedisProps(props: RedisProps | undefined): Buffer {
  const names = props ? Object.keys(props) : [];
  const header = Buffer.alloc(4);
  header.writeUInt32LE(names.length, 0);
  const parts: Buffer[] = [header];

  for (const name of names) {
    const prop = props![name] as Record<string, unknown>;
    const hasValue = Object.prototype.hasOwnProperty.call(prop, "value");
    const hasReturns = Object.prototype.hasOwnProperty.call(prop, "returns");
    if (hasValue === hasReturns) {
      throw new TypeError(
        `redisProps["${name}"] must have exactly one of "value" or "returns"`,
      );
    }

    const nameBuf = Buffer.from(name, "utf8");
    const nameHeader = Buffer.alloc(4);
    nameHeader.writeUInt32LE(nameBuf.length, 0);
    parts.push(nameHeader, nameBuf);

    const kind = hasValue ? PROP_KIND_FIELD : PROP_KIND_STUB;
    const raw = hasValue ? prop.value : prop.returns;
    parts.push(Buffer.from([kind]));
    parts.push(encodePropValue(raw, name, hasValue));
  }

  return Buffer.concat(parts);
}

/** Encodes the [vtype][payload] portion of one prop value. */
function encodePropValue(raw: unknown, name: string, isField: boolean): Buffer {
  if (raw === null || raw === undefined) {
    if (isField) {
      throw new TypeError(`redisProps["${name}"].value must not be null`);
    }
    return Buffer.from([PROP_VTYPE_NONE]);
  }
  if (typeof raw === "boolean") {
    return Buffer.from([PROP_VTYPE_BOOL, raw ? 1 : 0]);
  }
  if (typeof raw === "number") {
    const buf = Buffer.alloc(1 + 8);
    buf[0] = PROP_VTYPE_NUMBER;
    buf.writeDoubleLE(raw, 1);
    return buf;
  }
  if (typeof raw === "string") {
    const strBuf = Buffer.from(raw, "utf8");
    const buf = Buffer.alloc(1 + 4 + strBuf.length);
    buf[0] = PROP_VTYPE_STRING;
    buf.writeUInt32LE(strBuf.length, 1);
    strBuf.copy(buf, 5);
    return buf;
  }
  throw new TypeError(
    `redisProps["${name}"] value must be a string, number, boolean${isField ? "" : ", or null"}`,
  );
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:skip-wasm -- test/codec.test.ts`
Expected: PASS (all `encodeRedisProps` cases plus existing codec tests).

- [ ] **Step 6: Typecheck**

Run: `npm run build:ts`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add src/types.ts src/codec.ts test/codec.test.ts
git commit -m "feat(props): encodeRedisProps + RedisProps types (#12)"
```

---

### Task 2: Engine wiring — `host_redis_props` import + props handler

**Files:**
- Modify: `src/engine.ts` (add `props` to `MutableHandlers`, wire import in `load()`, set handler from `options.redisProps`)
- Modify: `src/loader-core.ts` (add `host_redis_props` to nothing structural — only `WasmExports` is typed there; no change needed unless typed import list exists — verify and skip if not)
- Test: `test/engine.test.ts` (add a unit test that the props handler returns the encoded blob via a stub exports object)

**Interfaces:**
- Consumes: `encodeRedisProps` (Task 1), `LoadOptions.redisProps` (Task 1), `allocAndWrite`/`returnPtrLen` from `./helpers.js`, `packPtrLen` not needed (returnPtrLen handles it).
- Produces:
  - `MutableHandlers.props: (...args: number[]) => bigint | void`
  - `hostImports.host_redis_props` registered in `load()`.

- [ ] **Step 1: Write the failing unit test in `test/engine.test.ts`**

Add this test (it exercises the handler directly via a fake exports object, so it needs no WASM rebuild). Import `encodeRedisProps` from `../src/codec.ts` and whatever helper builds the handler — since the handler is internal to `load()`, test it end-to-end through a fake module instead. Use this approach: build a minimal fake `WasmExports` and a captured imports map by stubbing `loadModule`. If that is too invasive for the existing test file, instead assert behavior through the real module in Task 3 and REMOVE this step.

Pragmatic version — assert the wiring exists by checking that `load()` accepts `redisProps` without throwing and that a round-trip blob decodes (pure handler logic). Add:

```typescript
import { encodeRedisProps } from "../src/codec.ts";

describe("redisProps handler", () => {
  it("allocates the encoded blob and returns a PtrLen (direct ABI)", () => {
    // Simulate the handler body the engine wires.
    const heap = new Uint8Array(1024);
    let next = 8;
    const exports = {
      HEAPU8: heap,
      _alloc: (n: number) => {
        const p = next;
        next += n;
        return p;
      },
    } as unknown as import("../src/loader-core.ts").WasmExports;

    const blob = encodeRedisProps({ V: { value: "7.4.0" } });
    // Mirror the handler: direct ABI (no retPtr) -> packed bigint.
    const { makePropsHandler } = require("../src/engine.ts");
    const handler = makePropsHandler(exports, blob);
    const packed = handler() as bigint;
    const ptr = Number(packed & 0xffffffffn);
    const len = Number(packed >> 32n);
    assert.equal(len, blob.length);
    assert.deepEqual([...heap.subarray(ptr, ptr + len)], [...blob]);
  });

  it("returns a zero PtrLen when there are no props", () => {
    const { makePropsHandler } = require("../src/engine.ts");
    const handler = makePropsHandler({} as never, Buffer.alloc(4));
    // count==0 blob is treated as "no props": ptr 0, len 0.
    const packed = handler() as bigint;
    assert.equal(packed, 0n);
  });
});
```

> Note for the implementer: to make the handler unit-testable, Task 2 extracts the handler body into an exported helper `makePropsHandler(exports, blob)` in `src/engine.ts`. The `load()` wiring calls this helper. If `require` interop is awkward under tsx/ESM, switch the import to `import { makePropsHandler } from "../src/engine.ts";` at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:skip-wasm -- test/engine.test.ts`
Expected: FAIL — `makePropsHandler is not a function` / not exported.

- [ ] **Step 3: Implement the handler + wiring in `src/engine.ts`**

Add `encodeRedisProps` to the codec import:

```typescript
import {
  decodeReply,
  encodeArgArray,
  encodeRedisProps,
  ensureBuffer,
  REPLY_SCRIPT_ERROR,
  unpackPtrLen,
} from "./codec.js";
```

Add `returnPtrLen` is already imported; ensure `allocAndWrite` and `returnPtrLen` are in the helpers import (they are).

Add `props` to `MutableHandlers`:

```typescript
type MutableHandlers = {
  log: (level: number, ptr: number, len: number) => void;
  sha1hex: (...args: number[]) => bigint | void;
  call: (...args: number[]) => bigint | void;
  pcall: (...args: number[]) => bigint | void;
  props: (...args: number[]) => bigint | void;
};
```

Add the exported helper near the other module-level functions (e.g. after `buildScriptError`):

```typescript
/**
 * Builds the `host_redis_props` handler. The import takes no input args and
 * returns a PtrLen blob (the encoded redisProps). A `count == 0` blob (length 4)
 * is treated as "no props" and returns a zero PtrLen so C skips application.
 *
 * ABI: under sret the runtime passes a single retPtr arg; under direct return it
 * passes none. We detect via arg count, mirroring parseAbiArgs but with no input
 * pointer.
 *
 * @internal exported for testing.
 */
export function makePropsHandler(
  exports: WasmExports,
  blob: Buffer,
): (...args: number[]) => bigint | void {
  const empty = blob.length <= 4; // only the u32 count, zero entries
  return (...args: number[]): bigint | void => {
    const hasRet = args.length >= 1;
    const abiArgs = { hasRet, retPtr: hasRet ? args[0] : 0, ptr: 0, len: 0 };
    const ptrLen = empty
      ? { ptr: 0, len: 0 }
      : { ptr: allocAndWrite(exports, blob), len: blob.length };
    return returnPtrLen(exports.HEAPU8, abiArgs, ptrLen);
  };
}
```

In `load()`, build the blob from options and wire the import + handler. Update the handlers initializer and the imports map:

```typescript
  const handlers: MutableHandlers = {
    log: () => {},
    sha1hex: () => BigInt(0),
    call: () => BigInt(0),
    pcall: () => BigInt(0),
    props: () => BigInt(0),
  };

  const hostImports: Record<string, HostImport> = {
    host_redis_log: (level: number, ptr: number, len: number) =>
      handlers.log(level, ptr, len),
    host_sha1hex: (...args: number[]) => handlers.sha1hex(...args),
    host_redis_call: (...args: number[]) => handlers.call(...args),
    host_redis_pcall: (...args: number[]) => handlers.pcall(...args),
    host_redis_props: (...args: number[]) => handlers.props(...args),
  };

  const { exports } = await loadModule(options, hostImports);

  // Wire the props handler now that we have real exports + the encoded blob.
  handlers.props = makePropsHandler(exports, encodeRedisProps(options.redisProps));

  return new LuaWasmModule(exports, handlers, options);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:skip-wasm -- test/engine.test.ts`
Expected: PASS for the two new `redisProps handler` cases (other engine tests that need WASM are unaffected here since they already pass against the current build).

- [ ] **Step 5: Typecheck**

Run: `npm run build:ts`
Expected: no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine.ts test/engine.test.ts
git commit -m "feat(props): wire host_redis_props import + handler (#12)"
```

---

### Task 3: C decode + runtime integration + `server` alias

**Files:**
- Modify: `wasm/include/abi.h` (declare `host_redis_props`)
- Modify: `wasm/src/redis_api.h` (declare `apply_redis_props`)
- Modify: `wasm/src/redis_api.c` (add `read_f64_le`, `l_const_return`, `l_noop`, `apply_redis_props`)
- Modify: `wasm/src/runtime.c` (call import + apply + `server` alias in `init` and `reset`)
- Test: `test/engine.test.ts` (integration cases; require WASM rebuild)

**Interfaces:**
- Consumes: the wire blob from `encodeRedisProps` (Task 1) delivered via `host_redis_props` (Task 2).
- Produces:
  - `PtrLen host_redis_props(void);` (import)
  - `int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);` (0 ok, -1 malformed)

- [ ] **Step 1: Write the failing integration tests in `test/engine.test.ts`**

These need the rebuilt WASM (Step 4). Add:

```typescript
import { LuaWasmEngine } from "../src/engine.ts";

const noopHost = {
  redisCall: () => null,
  redisPcall: () => null,
  log: () => {},
};

describe("redisProps integration", () => {
  it("injects constant fields readable from Lua", async () => {
    const engine = await LuaWasmEngine.create({
      host: noopHost,
      redisProps: {
        REDIS_VERSION: { value: "7.4.0" },
        REPL_ALL: { value: 3 },
        FLAG: { value: true },
      },
    });
    assert.deepEqual(engine.eval("return redis.REDIS_VERSION"), Buffer.from("7.4.0"));
    assert.equal(engine.eval("return redis.REPL_ALL"), 3);
    assert.equal(engine.eval("return redis.FLAG"), 1); // true -> 1
  });

  it("injects a stub returning a constant", async () => {
    const engine = await LuaWasmEngine.create({
      host: noopHost,
      redisProps: { replicate_commands: { returns: true } },
    });
    assert.equal(engine.eval("return redis.replicate_commands()"), 1);
  });

  it("injects a noop stub that returns nothing", async () => {
    const engine = await LuaWasmEngine.create({
      host: noopHost,
      redisProps: { set_repl: { returns: null } },
    });
    assert.equal(engine.eval("return select('#', redis.set_repl(1))"), 0);
  });

  it("exposes server as an alias of redis with the same props", async () => {
    const engine = await LuaWasmEngine.create({
      host: noopHost,
      redisProps: { REDIS_VERSION: { value: "7.4.0" } },
    });
    assert.equal(engine.eval("return server == redis"), 1);
    assert.deepEqual(engine.eval("return server.REDIS_VERSION"), Buffer.from("7.4.0"));
  });

  it("aliases server even with no props", async () => {
    const engine = await LuaWasmEngine.create({ host: noopHost });
    assert.equal(engine.eval("return server == redis"), 1);
  });

  it("makes injected props readonly under globals protection", async () => {
    const engine = await LuaWasmEngine.create({
      host: noopHost,
      redisProps: { REDIS_VERSION: { value: "7.4.0" } },
    });
    const r = engine.eval("redis.REDIS_VERSION = 'x' return 1") as { err: Buffer };
    assert.ok(r && typeof r === "object" && "err" in r);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- test/engine.test.ts` (full build incl. WASM) — but the C is not yet changed, so even after rebuild the props are ignored.
Expected: FAIL — e.g. `redis.REDIS_VERSION` is `null`, `redis.replicate_commands` is a nil-call error.

(If a Docker/WASM rebuild is unavailable in this environment, note it and proceed to implement; the test author must run Step 5 where Docker is available.)

- [ ] **Step 3: Declare the import in `wasm/include/abi.h`**

Add to the `/* Host imports */` block (after `host_sha1hex`):

```c
PtrLen host_redis_props(void);
```

- [ ] **Step 4: Declare `apply_redis_props` in `wasm/src/redis_api.h`**

```c
#ifndef REDIS_LUA_WASM_REDIS_API_H
#define REDIS_LUA_WASM_REDIS_API_H

#include <lua.h>
#include <stddef.h>
#include <stdint.h>

void register_redis_api(lua_State *L);

/* Decodes the host_redis_props blob and assigns each entry onto the global
 * `redis` table. Returns 0 on success, -1 on a malformed blob. */
int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len);

#endif /* REDIS_LUA_WASM_REDIS_API_H */
```

- [ ] **Step 5: Implement decode in `wasm/src/redis_api.c`**

Add near the top helpers (after `read_i64_le`):

```c
static double read_f64_le(const uint8_t *src) {
  double d;
  memcpy(&d, src, sizeof(d)); /* wasm is little-endian */
  return d;
}
```

Add the closures (before `apply_redis_props`):

```c
/* Stub function bodies for host-injected props. l_const_return returns its single
 * upvalue (the configured constant); l_noop returns nothing. */
static int l_const_return(lua_State *L) {
  lua_pushvalue(L, lua_upvalueindex(1));
  return 1;
}

static int l_noop(lua_State *L) {
  (void)L;
  return 0;
}
```

Add the decoder. Wire constants mirror `src/codec.ts`:

```c
#define PROP_KIND_FIELD 0
#define PROP_KIND_STUB 1
#define PROP_VTYPE_NONE 0
#define PROP_VTYPE_BOOL 1
#define PROP_VTYPE_NUMBER 2
#define PROP_VTYPE_STRING 3

int apply_redis_props(lua_State *L, const uint8_t *buf, size_t len) {
  if (len < 4) {
    return 0; /* nothing to apply */
  }
  size_t off = 0;
  uint32_t count = read_u32_le(buf);
  off += 4;

  lua_getglobal(L, "redis");
  if (!lua_istable(L, -1)) {
    lua_pop(L, 1);
    return -1;
  }
  int redis_idx = lua_gettop(L);

  for (uint32_t i = 0; i < count; i++) {
    if (off + 4 > len) {
      lua_pop(L, 1);
      return -1;
    }
    uint32_t name_len = read_u32_le(buf + off);
    off += 4;
    if (off + name_len > len) {
      lua_pop(L, 1);
      return -1;
    }
    const char *name = (const char *)(buf + off);
    off += name_len;

    if (off + 2 > len) {
      lua_pop(L, 1);
      return -1;
    }
    uint8_t kind = buf[off++];
    uint8_t vtype = buf[off++];

    /* Push the value (constant, or the stub's return value). */
    switch (vtype) {
      case PROP_VTYPE_NONE:
        lua_pushnil(L);
        break;
      case PROP_VTYPE_BOOL:
        if (off + 1 > len) { lua_pop(L, 1); return -1; }
        lua_pushboolean(L, buf[off] != 0);
        off += 1;
        break;
      case PROP_VTYPE_NUMBER:
        if (off + 8 > len) { lua_pop(L, 1); return -1; }
        lua_pushnumber(L, (lua_Number)read_f64_le(buf + off));
        off += 8;
        break;
      case PROP_VTYPE_STRING: {
        if (off + 4 > len) { lua_pop(L, 1); return -1; }
        uint32_t vlen = read_u32_le(buf + off);
        off += 4;
        if (off + vlen > len) { lua_pop(L, 1); return -1; }
        lua_pushlstring(L, (const char *)(buf + off), vlen);
        off += vlen;
        break;
      }
      default:
        lua_pop(L, 1);
        return -1;
    }

    /* Stack: [redis, value]. For a stub, replace value with a closure. */
    if (kind == PROP_KIND_STUB) {
      if (vtype == PROP_VTYPE_NONE) {
        lua_pop(L, 1); /* drop the nil placeholder */
        lua_pushcclosure(L, l_noop, 0);
      } else {
        lua_pushcclosure(L, l_const_return, 1); /* consumes value as upvalue */
      }
    }

    /* redis[name] = top-of-stack, binary-safe name. */
    lua_pushlstring(L, name, name_len); /* [redis, val, name] */
    lua_insert(L, -2);                  /* [redis, name, val] */
    lua_settable(L, redis_idx);         /* pops name+val */
  }

  lua_pop(L, 1); /* pop redis */
  return 0;
}
```

> Implementer note: `redis_api.c` already includes `<string.h>` and `<stdint.h>` (used by `memcpy`/`uint32_t`), and `read_u32_le`/`read_i64_le` already exist in the file. Do not redefine them.

- [ ] **Step 6: Call it from `wasm/src/runtime.c` in `init` and `reset`**

In `init()`, replace the body between `register_redis_api(g_state);` and `enable_globals_protection(g_state);` with:

```c
  open_allowed_libs(g_state);
  register_redis_api(g_state);
  {
    PtrLen props = host_redis_props();
    if (props.ptr && props.len) {
      int rc = apply_redis_props(g_state, (const uint8_t *)(uintptr_t)props.ptr,
                                 (size_t)props.len);
      free_mem(props.ptr);
      if (rc != 0) {
        return -1;
      }
    }
  }
  /* Redis 7.4+ exposes `server` as an alias of `redis`; same table reference so
   * both share the host-injected props. Must run before protection locks them. */
  lua_getglobal(g_state, "redis");
  lua_setglobal(g_state, "server");
  enable_globals_protection(g_state);
```

Apply the identical change inside `reset()` (same three-part sequence: apply props, alias `server`, then protect). Add `#include "redis_api.h"` is already present in runtime.c; confirm `abi.h` is included (it is, line 1).

- [ ] **Step 7: Rebuild WASM and run the integration tests**

Run: `npm test -- test/engine.test.ts`
Expected: PASS — all `redisProps integration` cases plus the existing engine suite. Specifically: `redis.REDIS_VERSION` → `Buffer "7.4.0"`, `redis.replicate_commands()` → `1`, `select('#', redis.set_repl(1))` → `0`, `server == redis` → `1`, writing `redis.REDIS_VERSION` → error reply.

- [ ] **Step 8: Run the full suite**

Run: `npm test`
Expected: PASS (no regressions in conformance/codec/sha1/run).

- [ ] **Step 9: Commit**

```bash
git add wasm/include/abi.h wasm/src/redis_api.h wasm/src/redis_api.c wasm/src/runtime.c test/engine.test.ts
git commit -m "feat(props): C decode of host redis props + server alias (#12)"
```

---

### Task 4: Docs

**Files:**
- Modify: `compat.md` (document `REDIS_VERSION*`, `server` alias, and the `redisProps` mechanism)
- Modify: `README.md` (if it documents `EngineOptions`/host setup — add `redisProps` example)

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing (docs only).

- [ ] **Step 1: Check what exists**

Run: `grep -n "REDIS_VERSION\|replicate_commands\|server\|redisProps" compat.md README.md`
Expected: locate the sections covering `redis.*` exclusions and option docs.

- [ ] **Step 2: Update `compat.md`**

In the section listing unimplemented/by-design `redis.*` members, note that `REDIS_VERSION`, `REDIS_VERSION_NUM`, the `REPL_*` constants, `replicate_commands`, `set_repl`/`get_repl`, and the `server` alias are now host-injectable via the `redisProps` option (blank slate; the package ships none by default). Document the `server` alias as created internally. Keep `register_function`/Functions and the Lua debugger listed as out of scope.

- [ ] **Step 3: Update `README.md`**

Add a short `redisProps` example to the options documentation:

````markdown
### Injecting `redis.*` props

The package ships no version-specific `redis.*` helpers by default. Supply them via `redisProps`:

```ts
const engine = await LuaWasmEngine.create({
  host,
  redisProps: {
    REDIS_VERSION:      { value: "7.4.0" },
    REPL_ALL:           { value: 3 },
    replicate_commands: { returns: true },  // function(...) return true end
    set_repl:           { returns: null },  // function(...) end (noop)
  },
});
```

`{ value }` sets a constant field; `{ returns }` sets a stub function that ignores its arguments and returns the given constant (`null` returns nothing). `server` is an internal alias of `redis`.
````

- [ ] **Step 4: Commit**

```bash
git add compat.md README.md
git commit -m "docs(props): document redisProps and server alias (#12)"
```

---

## Self-Review

**Spec coverage:**
- Interface (`RedisProp`/`RedisProps`/`LoadOptions.redisProps`) → Task 1. ✅
- Wire format → Task 1 (encoder) + Task 3 (decoder), constants mirrored. ✅
- Host import delivery (`host_redis_props`, handler, alloc pattern) → Task 2. ✅
- C decode + closures + `server` alias + init/reset ordering → Task 3. ✅
- `apply_redis_props` returns int, graceful init failure → Task 3 Step 5/6. ✅
- Testing (encoder units, integration: fields/stub/noop/server/readonly/reset) → Tasks 1 & 3. (reset persistence is implicitly covered because `reset()` shares the same code path; an explicit reset test is optional — add if `reset()` becomes part of the public API.) ✅
- Build impact / ABI version unchanged → Global Constraints. ✅
- Docs → Task 4. ✅

**Placeholder scan:** No TBD/TODO; all steps carry real code. The only conditional is Task 2 Step 1's `require` vs `import` interop note and Task 3 Step 2's Docker-availability note — both give an explicit fallback, not a placeholder.

**Type consistency:** `encodeRedisProps(props | undefined)`, `makePropsHandler(exports, blob)`, `apply_redis_props(L, buf, len) -> int`, `host_redis_props(void) -> PtrLen`, and the wire constants (`PROP_KIND_*`, `PROP_VTYPE_*`) match between TS (Task 1/2) and C (Task 3).
