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
  onSetResp?: (version: 2 | 3) => void;
};
```

The host reply ABI supports RESP2 replies plus RESP3 booleans, doubles, maps,
sets, big numbers, and verbatim strings. Push replies are not representable.

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

### onSetResp
- Optional. Invoked when the script calls `redis.setresp(n)` with the new
  version (`2` or `3`).
- The WASM encoder flips its own RESP mode regardless; this hook only lets the
  host mirror the protocol when choosing reply shapes for
  `redisCall`/`redisPcall`.
- Fires after validation, so it only ever receives `2` or `3`.

## ReplyValue

```ts
export type ReplyValue =
  | null
  | number
  | bigint
  | boolean
  | Buffer
  | { ok: Buffer }
  | { err: Buffer }
  | { double: number }
  | { big_number: Buffer }
  | { verbatim_string: { format: Buffer; string: Buffer } }
  | { map: [ReplyValue, ReplyValue][] }
  | { set: ReplyValue[] }
  | ReplyValue[];
```

## Binary safety
- No string coercion is applied to arguments.
- If you need strings, decode them from `Buffer` with an explicit encoding.
- To return binary data, return a `Buffer` or `{ ok: Buffer }`.
