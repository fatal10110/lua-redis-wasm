export type ReplyValue =
  | null
  | number
  | bigint
  | Buffer
  | { ok: Buffer }
  | { err: Buffer }
  | ReplyValue[];

export type RedisCallHandler = (args: Buffer[]) => ReplyValue;

export type RedisLogHandler = (level: number, message: Buffer) => void;

export type RedisHost = {
  redisCall: RedisCallHandler;
  redisPcall: RedisCallHandler;
  log: RedisLogHandler;
};

export type EngineLimits = {
  maxFuel?: number;
  maxMemoryBytes?: number;
  maxReplyBytes?: number;
  maxArgBytes?: number;
};

export type EngineOptions = {
  host: RedisHost;
  wasmPath?: string;
  wasmBytes?: Uint8Array;
  modulePath?: string;
  limits?: EngineLimits;
};

export type StandaloneOptions = {
  wasmPath?: string;
  wasmBytes?: Uint8Array;
  modulePath?: string;
  limits?: EngineLimits;
};
