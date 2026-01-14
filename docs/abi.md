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

Encoding details:
- `count_or_len` is byte length for bulk/status/error, and array element count for arrays.
- Integers are little-endian int64.
- Arrays are encoded as concatenated Reply entries.
- All string-like payloads are raw bytes and may include null bytes.

## Host Imports
The WASM module imports the following functions from the host:

- `host_redis_call(ptr, len) -> ptr_len`
  - Input: encoded argument array buffer.
  - Output: encoded Reply buffer.

- `host_redis_pcall(ptr, len) -> ptr_len`
  - Input: encoded argument array buffer.
  - Output: encoded Reply buffer; errors are returned as error replies.

- `host_redis_log(level, ptr, len) -> void`
  - Input: log level and message bytes.

- `host_sha1hex(ptr, len) -> ptr_len`
  - Input: raw bytes.
  - Output: 40-byte lowercase hex string as bytes.

## WASM Exports
The WASM module exports the following functions:

- `init() -> int`
  - Initializes the Lua VM and preloads modules.

- `reset() -> int`
  - Clears Lua state and re-initializes globals.

- `eval(ptr, len) -> ptr_len`
  - Evaluates a Lua script buffer and returns encoded Reply.

- `alloc(size) -> ptr`
  - Allocates `size` bytes in linear memory.

- `free_mem(ptr)`
  - Frees memory allocated by `alloc` or reply buffers.

## Argument Encoding
Arguments to `host_redis_call` and `host_redis_pcall` are encoded as:

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
- ABI version: 0
- Breaking changes require incrementing ABI version and updating `abi.h`.
