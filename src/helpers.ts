/**
 * @fileoverview Shared helper functions for WASM memory operations and ABI handling.
 * @module helpers
 */

import { createHash } from "node:crypto";
import { encodeReplyValue, packPtrLen } from "./codec.js";
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

/**
 * Allocates memory and writes data in one operation.
 * Returns the pointer to the allocated memory.
 */
export function allocAndWrite(exports: WasmExports, data: Buffer): number {
  const ptr = exports._alloc(data.length);
  writeBytes(exports.HEAPU8, ptr, data);
  return ptr;
}

/**
 * Encodes a ReplyValue and writes it to WASM memory.
 * Returns the pointer and length for passing back to WASM.
 */
export function encodeReplyToPtrLen(exports: WasmExports, value: ReplyValue): { ptr: number; len: number } {
  const encoded = encodeReplyValue(value);
  const ptr = allocAndWrite(exports, encoded);
  return { ptr, len: encoded.length };
}

/**
 * Writes a PtrLen struct to WASM memory for sret-style returns.
 * Layout: [ptr: u32le][len: u32le] = 8 bytes total
 */
function writePtrLen(heap: Uint8Array, retPtr: number, ptrLen: { ptr: number; len: number }): void {
  heap[retPtr] = ptrLen.ptr & 0xff;
  heap[retPtr + 1] = (ptrLen.ptr >> 8) & 0xff;
  heap[retPtr + 2] = (ptrLen.ptr >> 16) & 0xff;
  heap[retPtr + 3] = (ptrLen.ptr >> 24) & 0xff;
  heap[retPtr + 4] = ptrLen.len & 0xff;
  heap[retPtr + 5] = (ptrLen.len >> 8) & 0xff;
  heap[retPtr + 6] = (ptrLen.len >> 16) & 0xff;
  heap[retPtr + 7] = (ptrLen.len >> 24) & 0xff;
}

// =============================================================================
// ABI Helpers
// =============================================================================

/**
 * Parsed ABI arguments from a host import call.
 */
export interface AbiArgs {
  /** Whether the call uses sret (struct return) ABI */
  hasRet: boolean;
  /** Return pointer for sret ABI (0 if direct return) */
  retPtr: number;
  /** Pointer to input data */
  ptr: number;
  /** Length of input data */
  len: number;
}

/**
 * Parses ABI arguments to extract return pointer, data pointer, and length.
 * Handles both sret (3+ args) and direct return (2 args) ABI conventions.
 */
export function parseAbiArgs(args: number[]): AbiArgs {
  const hasRet = args.length >= 3;
  return {
    hasRet,
    retPtr: hasRet ? args[0] : 0,
    ptr: hasRet ? args[1] : args[0],
    len: hasRet ? args[2] : args[1]
  };
}

/**
 * Returns PtrLen result using the appropriate ABI convention.
 * For sret: writes to retPtr and returns void.
 * For direct: returns packed bigint.
 */
export function returnPtrLen(
  heap: Uint8Array,
  abiArgs: AbiArgs,
  ptrLen: { ptr: number; len: number }
): bigint | void {
  if (abiArgs.hasRet) {
    writePtrLen(heap, abiArgs.retPtr, ptrLen);
    return;
  }
  return packPtrLen(ptrLen.ptr, ptrLen.len);
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
  const hex = createHash("sha1").update(data).digest("hex");
  return Buffer.from(hex, "utf8");
}
