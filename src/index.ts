export { LuaWasmEngine } from "./engine.js";
export type {
  EngineOptions,
  EngineLimits,
  ReplyValue,
  RedisCallHandler,
  RedisHost,
  RedisLogHandler,
  StandaloneOptions
} from "./types.js";
import { encodeReplyValue, decodeReply, encodeArgArray } from "./codec.js";
import type { ReplyValue as ReplyValueType } from "./types.js";

export function encodeReply(value: ReplyValueType) {
  return encodeReplyValue(value);
}

export function decodeReplyBuffer(buffer: Buffer) {
  return decodeReply(buffer).value;
}

export function encodeArgs(args: Array<Buffer | Uint8Array | string>) {
  return encodeArgArray(args);
}
