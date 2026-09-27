# Binary-Safe ABI Specification

## Overview
This document defines the ABI between the Node.js host and the Lua 5.1 WASM module.
All data is binary-safe and passed as pointer + length pairs into WASM linear memory.
No null-termination or UTF-16 string conversion is permitted.

## Memory Model
- WASM linear memory is the single shared data exchange space.
- The host writes input buffers into linear memory via `alloc`.
- The WASM module reads input using pointer + length values.
- The WASM module writes outputs into linear memory and returns a pointer + length.
- The host is responsible for freeing buffers allocated via `alloc`.

## Ownership Rules
- Host allocations: created by calling exported `alloc`; freed by calling `free`.
- WASM allocations for replies: allocated by WASM, freed by host via `free`.
- No buffer is reused without explicit `free`.

## Reply Encoding
Replies are encoded as a flat byte buffer with the following layout:

```
struct Reply {
  uint8_t type;
  uint32_t count_or_len;
  // Followed by payload depending on type.
}
```

Reply `type` values:
- 0x00: null
- 0x01: integer (payload: int64)
- 0x02: bulk string (payload: bytes)
- 0x03: array (payload: repeated Reply)
- 0x04: status (payload: bytes)
- 0x05: error (payload: bytes)
- 0x06: script error (payload: line u32, flags u8, message bytes; see below)
- 0x07: boolean (payload: 1 byte, 0 or 1)
- 0x08: double (payload: float64 little-endian)
- 0x09: map (payload: repeated key Reply, value Reply pairs)
- 0x0a: set (payload: repeated Reply entries)
- 0x0b: big number (payload: bytes)
- 0x0c: verbatim string (payload: format length u32, format bytes, string bytes)

Encoding details:
- `count_or_len` is byte length for string-like payloads, array/set element
  count for arrays/sets, and pair count for maps.
- Integers are little-endian int64.
- Doubles are little-endian float64.
- Arrays, sets, and maps are encoded as concatenated Reply entries.
- All string-like payloads are raw bytes and may include null bytes.

### Script errors
A script error (0x06) is an error that aborted the script: a load or runtime
error, including one that propagated out of `redis.call`. Error *values* the
script returns (e.g. `return redis.pcall(...)`) are plain errors (0x05).
`count_or_len` covers the whole payload:

```
struct ScriptErrorPayload {
  uint32_t line;   // script line at the error point, 0 = unknown
  uint8_t flags;   // SCRIPT_ERROR_* below
  uint8_t message[count_or_len - 5];
}
```

- `line` 0 means the error handler did not run (load/syntax errors); the line
  is then parsed from the message's `user_script:N:` prefix.
- `flags` is set by the engine and never inferred from the message text, which
  scripts and host command errors control:
  - `0x01` `SCRIPT_ERROR_ENGINE`: the engine raised the error itself (globals
    protection, a bad `redis.call` argument). `message` is `<kind>` or
    `<kind>:<name>`, unsanitized: `name` is data (a global's name may contain
    CR/LF). Only the error the engine raised in the current eval, uncaught or
    rethrown unchanged, carries it.
  - `0x02` `SCRIPT_ERROR_FROM_TABLE`: `message` is the `err` field of an error
    table (`error({err=...})`, a `redis.call` error, the fuel kill). Redis 7
    sends it as-is (`-<err>`), so the host must not add a default error code.
    Set only in the Redis 7 error model (compat flag `0x10`): Redis 6.2 sends
    `-ERR ...` for every script error.
  - neither: a string (or other value) error, or any error in the Redis 6.2
    error model. Redis prefixes it with `ERR `; the engine reports the generic
    `ERR` code when the message has none.
- Except with `SCRIPT_ERROR_ENGINE`, `message` is cut at the first NUL, has
  trailing CR/LF trimmed and every other CR/LF mapped to a space, so it can be
  written into RESP as is.

## Calling Convention
`ptr_len` is the C struct `PtrLen { uint32_t ptr; uint32_t len; }`. clang's
wasm32 C ABI returns it through a hidden struct-return pointer, so at the WASM
level every `-> ptr_len` function takes an extra leading `ret_ptr` argument and
returns nothing: `eval(ptr, len)` is `eval(ret_ptr, ptr, len)`, and the host
import `host_redis_call(ptr, len)` is called as `host_redis_call(ret_ptr, ptr, len)`
and must write the 8-byte result (`ptr` then `len`, little-endian) at `ret_ptr`.

## Host Imports
The WASM module imports the following functions from the host. A host import
must never throw: an exception would unwind through the running Lua VM's WASM
frames and corrupt it. Failures are reported through the return value instead,
and the C side raises them as ordinary Lua errors.

- `host_redis_call(ptr, len) -> ptr_len`
  - Input: encoded argument array buffer.
  - Output: encoded Reply buffer. An error reply is raised as a Lua error.
    `{0,0}` raises `ERR empty reply from host`.

- `host_redis_pcall(ptr, len) -> ptr_len`
  - Input: encoded argument array buffer.
  - Output: encoded Reply buffer; errors are returned as error replies.

- `host_redis_log(level, ptr, len) -> ptr_len`
  - Input: log level and message bytes.
  - Output: `{0,0}` on success. On failure `len != 0` and `ptr` is an
    `alloc`'d error message (or 0 when none could be allocated); WASM frees it
    and raises it as a Lua error.

- `host_redis_setresp(version) -> ptr_len`
  - Input: the RESP version the script switched to (2 or 3).
  - Output: as `host_redis_log`. On failure the protocol is not switched.

- `host_sha1hex(ptr, len) -> ptr_len`
  - Input: raw bytes.
  - Output: 40-byte lowercase hex string as bytes. `{0,0}` raises
    `ERR sha1hex failed`.

- `host_redis_props() -> ptr_len`
  - Output: encoded redisProps blob applied to the `redis` table at `init`/
    `reset`, or `{0,0}` for none.

## WASM Exports
The WASM module exports the following functions:

- `init() -> int`
  - Initializes the Lua VM and preloads modules. Returns 0, or -1 while an
    eval is active or when the VM could not be built.

- `reset() -> int`
  - Replaces the Lua VM with a fresh one (`LuaEngine.reset()`). Limits and
    compat flags are kept, props are fetched again through `host_redis_props`,
    and a missing VM (a failed build, or after `close_vm`) is rebuilt. Returns
    0, or -1 while an eval is active or when the VM could not be built.

- `close_vm() -> int`
  - Closes the Lua VM for good (`LuaEngine.dispose()`); later evals reply
    `ERR Lua VM not initialized`. Idempotent. Returns 0, or -1 while an eval
    is active.

- `eval(ptr, len) -> ptr_len`
  - Evaluates a Lua script buffer and returns encoded Reply.

- `eval_with_args(script_ptr, script_len, args_ptr, args_len, keys_count) -> ptr_len`
  - Evaluates a Lua script buffer with binary-safe KEYS/ARGV provided by the host.

- `alloc(size) -> ptr`
  - Allocates `size` bytes in linear memory. The heap is fixed-size (64 MB)
    and the module is linked with `-sABORTING_MALLOC=0`, so an exhausted heap
    returns 0, which callers must treat as an allocation failure (the engine
    throws a recoverable `RangeError`). A Lua script exhausting the heap gets
    an ordinary `not enough memory` error; the runtime runs a full garbage
    collection after any `eval` that leaves more than 16 MB of Lua memory in
    use (and rebuilds the VM if that collection runs out of memory). Every Lua
    call on the eval path runs protected; a `lua_atpanic` handler turns an
    error that still escapes into an error reply and a rebuilt VM. `cmsgpack` allocates without NULL checks, so it is compiled
    (`wasm/src/lua_cmsgpack_checked.c`) against an allocator that aborts on
    OOM, like Redis's. An exception thrown *from* `alloc` (or any other
    export) unwound WASM frames without their cleanup, so the engine treats it
    as fatal and refuses further evaluations.

- `free_mem(ptr)`
  - Frees memory allocated by `alloc` or reply buffers.

- `set_limits(max_fuel, max_reply_bytes, max_arg_bytes) -> void`
  - Sets optional runtime limits. Values of 0 disable the corresponding limit.

## Argument Encoding
Arguments to `host_redis_call`, `host_redis_pcall`, and `eval_with_args` are encoded as:

```
struct ArgArray {
  uint32_t count;
  ArgEntry entries[count];
}

struct ArgEntry {
  uint32_t len;
  uint8_t bytes[len];
}
```

- Argument values are raw byte arrays.
- No UTF-8 validation is performed.

## Endianness
- All integers are little-endian.

## Errors
- Errors inside Lua script must be returned as `error` reply type.
- Host-side failures must map to `error` replies with Redis-like error strings.

## Versioning
- ABI version: 2
  - 2: the script error (0x06) payload carries a `flags` byte after `line`.
  - 1: `host_redis_log`/`host_redis_setresp` return a failure `ptr_len`.
- Breaking changes require incrementing ABI version and updating `abi.h`.
