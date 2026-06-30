export { load, LuaWasmModule, LuaEngine, LuaWasmEngine } from "./engine.js";
export type {
  EngineOptions,
  EngineLimits,
  LoadOptions,
  ReplyValue,
  ReplyErrorMeta,
  RedisCallHandler,
  RedisHost,
  RedisLogHandler,
  StandaloneOptions,
  RedisProp,
  RedisProps
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
