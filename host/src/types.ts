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

export type EngineOptions = {
  host: RedisHost;
  wasmPath?: string;
  wasmBytes?: Uint8Array;
};

export type StandaloneOptions = {
  wasmPath?: string;
  wasmBytes?: Uint8Array;
};
