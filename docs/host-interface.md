# Host Interface Contract

This document describes the host contract required by the Redis Lua WASM engine.

## Overview
- The engine calls host functions to implement `redis.call`, `redis.pcall`, and `redis.log`.
- All arguments are binary-safe and passed as `Buffer` values.
- Replies must be shaped as Redis-compatible reply values.

## RedisHost

```ts
export type RedisCallHandler = (args: Buffer[]) => ReplyValue;
export type RedisLogHandler = (level: number, message: Buffer) => void;

export type RedisHost = {
  redisCall: RedisCallHandler;
  redisPcall: RedisCallHandler;
  log: RedisLogHandler;
};
```

### redisCall
- Invoked for `redis.call(...)`.
- Receives the command name and arguments as `Buffer[]`.
- May throw to signal an error; the engine converts it to `{ err: Buffer }`.

### redisPcall
- Invoked for `redis.pcall(...)`.
- Receives the command name and arguments as `Buffer[]`.
- Should return `{ err: Buffer }` instead of throwing.

### log
- Invoked for `redis.log(level, message)`.
- `level` is the numeric Redis log level.
- `message` is a binary-safe `Buffer`.

## ReplyValue

```ts
export type ReplyValue =
  | null
  | number
  | bigint
  | Buffer
  | { ok: Buffer }
  | { err: Buffer }
  | ReplyValue[];
```

## Binary safety
- No string coercion is applied to arguments.
- If you need strings, decode them from `Buffer` with an explicit encoding.
- To return binary data, return a `Buffer` or `{ ok: Buffer }`.

