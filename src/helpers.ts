/**
 * @fileoverview Shared helper functions for WASM memory operations and ABI handling.
 * @module helpers
 */

import { sha1Hex } from "./sha1.js";
import { encodeReplyValue } from "./codec.js";
import type { ReplyValue } from "./types.js";
import type { WasmExports } from "./loader.js";

// =============================================================================
// Memory Helpers
// =============================================================================

/**
 * Reads bytes from WASM linear memory into a Buffer.
 * Binary-safe - no string coercion or encoding transformation.
 */
export function readBytes(heap: Uint8Array, ptr: number, len: number): Buffer {
  return Buffer.from(heap.subarray(ptr, ptr + len));
}

/**
 * Writes a Buffer into WASM linear memory at the given pointer.
 */
function writeBytes(heap: Uint8Array, ptr: number, data: Buffer): void {
  heap.set(data, ptr);
}

/** A `{ ptr, len }` pair as laid out by the C `PtrLen` struct. */
export type PtrLen = { ptr: number; len: number };

/**
 * Allocates `size` bytes in WASM linear memory.
 *
 * The heap is fixed-size, so `malloc` can fail: it returns 0, or, with
 * Emscripten's default aborting malloc, throws "Aborted(OOM)". Both become a
 * RangeError instead of letting the caller write over address 0. Zero-byte
 * requests allocate one byte so an empty payload still gets a real pointer.
 *
 * @throws RangeError if the allocation fails
 */
export function alloc(exports: WasmExports, size: number): number {
  let ptr: number;
  try {
    ptr = exports._alloc(Math.max(size, 1));
  } catch (cause) {
    throw new RangeError(`WASM heap exhausted: failed to allocate ${size} bytes`, { cause });
  }
  if (!ptr) {
    throw new RangeError(`WASM heap exhausted: failed to allocate ${size} bytes`);
  }
  return ptr;
}

/**
 * Allocates memory and writes data in one operation.
 * Returns the pointer to the allocated memory.
 * @throws RangeError if the allocation fails
 */
export function allocAndWrite(exports: WasmExports, data: Buffer): number {
  const ptr = alloc(exports, data.length);
  writeBytes(exports.HEAPU8, ptr, data);
  return ptr;
}

/**
 * Encodes a ReplyValue and writes it to WASM memory.
 * Returns the pointer and length for passing back to WASM.
 */
export function encodeReplyToPtrLen(exports: WasmExports, value: ReplyValue): PtrLen {
  const encoded = encodeReplyValue(value);
  const ptr = allocAndWrite(exports, encoded);
  return { ptr, len: encoded.length };
}

// =============================================================================
// ABI Helpers
// =============================================================================
//
// clang's wasm32 C ABI returns the two-field PtrLen struct through a hidden
// struct-return pointer: every PtrLen-returning export takes it as its first
// argument, and every PtrLen-returning host import receives it as its first
// argument and writes the result there.

/**
 * Writes a PtrLen struct to WASM memory for sret-style returns.
 * Layout: [ptr: u32le][len: u32le] = 8 bytes total
 */
export function writePtrLen(heap: Uint8Array, retPtr: number, ptrLen: PtrLen): void {
  heap[retPtr] = ptrLen.ptr & 0xff;
  heap[retPtr + 1] = (ptrLen.ptr >> 8) & 0xff;
  heap[retPtr + 2] = (ptrLen.ptr >> 16) & 0xff;
  heap[retPtr + 3] = (ptrLen.ptr >> 24) & 0xff;
  heap[retPtr + 4] = ptrLen.len & 0xff;
  heap[retPtr + 5] = (ptrLen.len >> 8) & 0xff;
  heap[retPtr + 6] = (ptrLen.len >> 16) & 0xff;
  heap[retPtr + 7] = (ptrLen.len >> 24) & 0xff;
}

/**
 * Reads a PtrLen struct written by WASM at `base`.
 */
export function readPtrLen(heap: Uint8Array, base: number): PtrLen {
  const ptr =
    (heap[base] | (heap[base + 1] << 8) | (heap[base + 2] << 16) | (heap[base + 3] << 24)) >>> 0;
  const len =
    (heap[base + 4] | (heap[base + 5] << 8) | (heap[base + 6] << 16) | (heap[base + 7] << 24)) >>> 0;
  return { ptr, len };
}

// =============================================================================
// Argument Decoding
// =============================================================================

/**
 * Decodes an ArgArray payload from a Buffer into Buffer arguments.
 * Wire format: [count: u32le][len: u32le][bytes]...
 */
export function decodeArgs(buf: Buffer): Buffer[] {
  if (buf.length < 4) {
    throw new Error("ERR invalid argument encoding");
  }
  const count = buf.readUInt32LE(0);
  const out: Buffer[] = [];
  let offset = 4;
  for (let i = 0; i < count; i += 1) {
    if (offset + 4 > buf.length) {
      throw new Error("ERR invalid argument encoding");
    }
    const argLen = buf.readUInt32LE(offset);
    offset += 4;
    if (offset + argLen > buf.length) {
      throw new Error("ERR invalid argument encoding");
    }
    out.push(Buffer.from(buf.subarray(offset, offset + argLen)));
    offset += argLen;
  }
  return out;
}

// =============================================================================
// SHA1 Helper
// =============================================================================

/**
 * Computes SHA1 hex digest from input data.
 * Returns 40-char hex string as Buffer.
 */
export function computeSha1Hex(data: Buffer): Buffer {
  return Buffer.from(sha1Hex(data), "utf8");
}
