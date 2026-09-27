# lua-redis-wasm

[![npm version](https://img.shields.io/npm/v/lua-redis-wasm.svg)](https://www.npmjs.com/package/lua-redis-wasm)
[![CI](https://github.com/fatal10110/lua-redis-wasm/workflows/ci/badge.svg)](https://github.com/fatal10110/lua-redis-wasm/actions)
[![Node.js Version](https://img.shields.io/node/v/lua-redis-wasm.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Run Redis Lua scripts (`EVAL` / `EVALSHA`) in Node.js or the browser, without a Redis server.**

lua-redis-wasm is the Lua 5.1 scripting engine of Redis, compiled to
WebAssembly. You give it a script plus `KEYS` and `ARGV`; whenever the script
calls `redis.call(...)`, the engine calls a JavaScript function you provide, so
the script can work on your own data. Replies, errors and Lua libraries behave
the way they do in a real Redis or Valkey server.

> **Primary purpose:** this engine powers the Lua scripting (`EVAL`/`EVALSHA`)
> support in [js-redis-server](https://github.com/fatal10110/js-redis-server), an
> in-memory Redis-compatible server ([browser demo](https://fatal10110.github.io/js-redis-server/)).
> It is published as a standalone package so it can be reused, but its API and
> error semantics are driven by what js-redis-server needs to match real Redis.
> If you embed it directly, expect it to behave the way Redis behaves inside
> that server.

## Features

- **Redis-compatible Lua 5.1**: the Lua that Redis and Valkey embed, with their
  sandbox, globals protection and value conversions.
- **Your data, your commands**: `redis.call`, `redis.pcall` and `redis.log` call
  JavaScript functions you write.
- **Binary-safe**: scripts, `KEYS`, `ARGV` and replies are bytes (`Buffer`), null
  bytes included.
- **Resource limits**: a deterministic instruction budget, reply and argument
  size caps, and a fixed-size memory heap per engine, so a runaway script
  cannot hang your process.
- **Redis standard libraries**: `cjson`, `cmsgpack`, `struct` and `bit`.
- **Version profiles**: emulate Redis 6.2 to 8.0 or Valkey 8.0 to 9.0.
- **Node.js and browsers**, with TypeScript types included.

## Install

```bash
npm install lua-redis-wasm
```

Requires Node.js 22 or later. Browsers are supported through bundlers (see
[Use in the browser](#use-in-the-browser)).

## Quick start

```typescript
import { LuaEngine } from "lua-redis-wasm";

const data = new Map<string, Buffer>();

const engine = await LuaEngine.create({
  host: {
    // Called for redis.call(...). args[0] is the command name.
    redisCall(args) {
      const [cmd, key, value] = args;
      switch (cmd.toString().toUpperCase()) {
        case "GET":
          return data.get(key.toString()) ?? null;
        case "SET":
          data.set(key.toString(), value);
          return { ok: Buffer.from("OK") };
        default:
          throw new Error(`ERR unknown command '${cmd}'`);
      }
    },
    // Called for redis.pcall(...): return errors instead of throwing.
    redisPcall(args, ctx) {
      try {
        return this.redisCall(args, ctx);
      } catch (err) {
        return { err: Buffer.from((err as Error).message) };
      }
    },
    // Called for redis.log(level, ...).
    log(level, message) {
      console.log(`[redis.log ${level}] ${message.toString()}`);
    },
  },
});

engine.eval("return 1 + 1"); // 2

const reply = engine.evalWithArgs(
  "redis.call('SET', KEYS[1], ARGV[1]) return redis.call('GET', KEYS[1])",
  [Buffer.from("greeting")], // KEYS
  [Buffer.from("hello")], // ARGV
);
console.log(reply?.toString()); // "hello"

engine.dispose(); // free the engine's memory when you are done
```

## Guide

### Run a script

`engine.eval(script)` runs a Lua script and returns its result as a
[reply value](#reply-values). Lua strings come back as `Buffer`s, numbers as
integers, tables as arrays:

```typescript
engine.eval("return 'hello'"); // Buffer.from("hello")
engine.eval("return {1, 2, 3}"); // [1, 2, 3]
engine.eval("return 3.7"); // 3 (Redis truncates numbers to integers)
engine.eval("return nil"); // null
```

The script can be a `string`, `Buffer` or `Uint8Array`. Evaluation is
synchronous: the call returns when the script has finished.

### Pass KEYS and ARGV

`engine.evalWithArgs(script, keys, args)` sets the script's `KEYS` and `ARGV`
tables. Pass them as `Buffer`s; they may contain any bytes:

```typescript
engine.evalWithArgs(
  "return {KEYS[1], ARGV[1], ARGV[2]}",
  [Buffer.from("key:1")],
  [Buffer.from("arg1"), Buffer.from("arg2\x00with-null")],
);
```

### Connect `redis.call` to your data

The `host` object you pass to `LuaEngine.create` is how scripts reach your
data. It has three required callbacks and one optional one:

| Callback | Called for | What to do |
|---|---|---|
| `redisCall(args, ctx)` | `redis.call(...)` | Run the command and return a reply. Throw (or return `{ err }`) to fail it. |
| `redisPcall(args, ctx)` | `redis.pcall(...)` | Same, but return `{ err: Buffer }` instead of throwing, as Redis does. |
| `log(level, message)` | `redis.log(level, ...)` | Log the message. `level` is 0 (debug) to 3 (warning). |
| `onSetResp(version)` | `redis.setresp(2 \| 3)` | Optional. Switch the reply shapes you return to RESP2 or RESP3. |

Things to know:

- `args` are `Buffer`s; `args[0]` is the command name. Lua numbers arrive
  formatted the way Redis 7.4+ formats them (`1e15` → `"1000000000000000"`).
- Return a [reply value](#reply-values): `null`, a number, a `Buffer`,
  `{ ok }` for a status reply, `{ err }` for an error, an array, or a RESP3
  type.
- A thrown exception becomes an error reply. If its message does not start with
  an uppercase error code, `ERR` is added (`throw new Error("oops")` →
  `ERR oops`). To choose the code, throw `new Error("WRONGTYPE ...")` or return
  `{ err: Buffer.from("WRONGTYPE ...") }`.
- A callback that throws never breaks the engine. A `log` or `onSetResp` that
  throws raises a Lua error in the script.
- `ctx` describes the Lua line that made the call (`ctx.source`, `ctx.line`),
  for hosts that need Redis 6.2's `@user_script: <line>:` error prefix. Read
  `ctx.source` inside the callback, and pass `ctx` along when one handler calls
  another.
- Don't run another script on the same engine from inside a callback: it is
  refused with `ERR nested eval is not supported: a script is already running`.

Details: [docs/host-interface.md](docs/host-interface.md).

### Handle errors

A script that fails does not make `eval` throw. `eval` returns an error reply
instead, the same way Redis sends an error to its client:

```typescript
engine.eval("return redis.call('NOPE')");
// {
//   err: Buffer.from("unknown command 'NOPE'"),
//   code: Buffer.from("ERR"),
//   meta: { line: 1, sha: "19965f96bed2e953a3424cfa591695dc2a3e81db" },
// }
```

- `err` is the message and `code` the error code (`ERR`, `WRONGTYPE`, ...).
  `code` can be missing, as Redis 7 sends some errors without one (for example
  `error({err='boom'})`). Send `-<code> <err>`, or `-<err>` without a code.
- `meta` tells you where the script failed: `line` and the script's `sha`.
  Redis adds them to the message as
  `<message> script: <sha>, on @user_script:<line>.`
- `meta.kind` is set for errors the engine raises itself, such as reading an
  undefined global (`global-read`, with the variable in `meta.name`). For these
  `err` is just the kind; replace it with Redis's wording (listed in
  [docs/errors.md](docs/errors.md#meta)).
- An error the script *returns* (for example `return redis.pcall(...)`) comes
  back as `{ err, code }` without `meta`, unchanged.

To render a script error the way Redis does:

```typescript
const reply = engine.eval("return redis.call('NOPE')");
if (reply && typeof reply === "object" && "err" in reply && reply.meta) {
  const message = reply.code ? `${reply.code} ${reply.err}` : `${reply.err}`;
  console.log(`-${message} script: ${reply.meta.sha}, on @user_script:${reply.meta.line}.`);
}
```

`eval` throws only when the engine itself cannot run the script: a script or
`KEYS`/`ARGV` too large for the engine's memory (`RangeError`; the engine keeps
working), or a failure inside the WebAssembly module, after which the engine is
unusable and you should create a new one. It also throws once the engine has
been disposed. Inside scripts, `redis.call` errors
are Redis 7 `{err=...}` tables by default; the `redis-6.2`
[profile](#pick-a-redisvalkey-compatibility-profile) uses plain strings.

Details: [docs/errors.md](docs/errors.md).

### Limit script runtime and size

Scripts run with an instruction budget, so an endless loop cannot hang your
process. Set `limits` to change it, or to cap reply and argument sizes:

```typescript
const engine = await LuaEngine.create({
  host,
  limits: {
    maxFuel: 50_000_000, // Lua instructions per script
    maxReplyBytes: 2 * 1024 * 1024, // largest reply a script may return
    maxArgBytes: 1024 * 1024, // largest KEYS + ARGV
  },
});

engine.eval("while true do end");
// {
//   err: Buffer.from("Script killed by fuel limit"),
//   code: Buffer.from("ERR"),
//   meta: { line: 1, sha: "..." },
// }
```

| Limit | Default | When exceeded, the script replies |
|---|---|---|
| `maxFuel` | 10,000,000 instructions | `ERR Script killed by fuel limit` |
| `maxReplyBytes` | no limit | `ERR reply exceeds configured limit` |
| `maxArgBytes` | no limit | `ERR KEYS/ARGV exceeds configured limit` |

- Limits must be non-negative integers; anything else throws a `RangeError`.
- `0` means "no limit" for the byte limits and "the default" for `maxFuel`:
  the instruction budget can be raised but not switched off.
- The budget counts Lua instructions, not time, so results are deterministic.
  Time spent in your callbacks is not counted, and a script cannot escape the
  budget with `pcall`.
- Each engine has a fixed 64 MB memory heap. A script that runs out of memory
  gets a `not enough memory` error, and the engine keeps working.

Details: [docs/limits.md](docs/limits.md).

### Pick a Redis/Valkey compatibility profile

Redis versions differ slightly in what scripts can see. Set `profile` to match
the server you are emulating:

```typescript
const engine = await LuaEngine.create({ host, profile: "redis-7.2" });
```

| `profile` | `print` | `os` library | `server` alias | Errors inside scripts | `math.random` |
|---|---|---|---|---|---|
| `redis-6.2` | yes | no | no | strings | reseeded before every script |
| `redis-7.0`, `redis-7.2` | no | no | no | `{err=...}` tables | one sequence across scripts |
| `redis-7.4`, `redis-8.0` | no | yes | no | `{err=...}` tables | one sequence across scripts |
| `valkey-8.0`, `valkey-9.0` | no | yes | yes | `{err=...}` tables | one sequence across scripts |
| none (default) | no | yes | yes | `{err=...}` tables | one sequence across scripts |

Profiles also pick each version's wording for a few error messages. To change
a single behavior, add `compat` on top of the profile:

| `compat` key | Effect |
|---|---|
| `print` | Keep Lua's `print` global. |
| `os` | Expose the sandboxed `os` library (`os.clock` only). |
| `serverAlias` | Expose `server` as an alias of `redis`. |
| `reseedRandom` | Reseed `math.random` with 0 before every script. |
| `tableErrors` | Use Redis 7 error tables (`false` gives Redis 6.2 string errors). |

```typescript
// Redis 8.0, but with Redis 6.2 string errors
const engine = await LuaEngine.create({
  host,
  profile: "redis-8.0",
  compat: { tableErrors: false },
});
```

Details: [docs/compat.md](docs/compat.md).

### Add `redis.*` constants and stubs

The engine does not define version-specific members such as
`redis.REDIS_VERSION` or `redis.replicate_commands()`. Add the ones your
scripts need with `redisProps`:

```typescript
const engine = await LuaEngine.create({
  host,
  redisProps: {
    REDIS_VERSION: { value: "7.4.0" },
    REPL_ALL: { value: 3 },
    replicate_commands: { returns: true }, // function(...) return true end
    set_repl: { returns: null }, // function(...) end (does nothing)
  },
});
```

`{ value }` sets a constant; `{ returns }` sets a function that ignores its
arguments and returns the given value (`null` returns nothing). When the
`server` alias is enabled, it sees the same members.

### Run pure Lua without a host

`LuaEngine.createStandalone()` creates an engine with no host callbacks, for
scripts that only compute. `redis.call` raises
`ERR redis.call is not available in standalone mode`, and `redis.pcall`
returns `ERR redis.pcall is not available in standalone mode` as an error
table:

```typescript
const calc = await LuaEngine.createStandalone({ limits: { maxFuel: 1_000_000 } });
calc.eval("return math.sqrt(16)"); // 4
calc.eval("return cjson.encode({a = 1})"); // Buffer.from('{"a":1}')
calc.dispose();
```

It takes the same options as `LuaEngine.create`, without `host`.

### Clean up an engine

- `engine.reset()` replaces the Lua VM with a fresh one, discarding whatever
  earlier scripts changed (for example `cjson` settings). Limits, profile,
  `redisProps` and host callbacks are kept, and so is the `math.random`
  sequence, as on a real server.
- `engine.dispose()` releases the engine and its 64 MB of WebAssembly memory.
  Afterwards `eval`, `evalWithArgs` and `reset` throw. Calling `dispose()` twice
  is fine.

```typescript
const engine = await LuaEngine.createStandalone();
try {
  engine.eval("return 1");
} finally {
  engine.dispose();
}
```

Both throw when called from inside one of the engine's host callbacks; call
them after `eval` returns. If `reset()` cannot build the new VM (out of memory),
it throws, and every `eval` replies `ERR Lua VM not initialized` until a later
`reset()` succeeds.

### Load the WASM module yourself

`LuaEngine.create(options)` is `load(options)` followed by
`module.create(options.host)`. Split the two steps to load asynchronously once
and create the engine synchronously later:

```typescript
import { load } from "lua-redis-wasm";

const module = await load({ limits: { maxFuel: 10_000_000 } });
const engine = module.create(host); // or module.createStandalone()
```

- A module creates exactly one engine; call `load()` again for another one.
  Engines never share state.
- The compiled WebAssembly code is cached for the process, so only the first
  `load()` reads and compiles the binary.
- `wasmPath` points at another `redis_lua.wasm` (a file path or `file://` URL
  in Node, a URL in the browser); `wasmBytes` passes the binary directly
  (`Uint8Array` or `ArrayBuffer`); `modulePath` points at the matching
  `redis_lua.mjs` glue. Use binaries built from the same release as the
  package.

### Use in the browser

Bundlers such as Vite, webpack and Rollup pick the package's browser build
automatically (through the `browser` export condition). The build itself has
no `node:*` imports and fetches `redis_lua.wasm` from next to the module; if
your bundler does not copy that file, serve it yourself and pass its URL as
`wasmPath`, or fetch it and pass `wasmBytes`.

The Emscripten glue it loads (`redis_lua.mjs`) is shared with Node, so it
still mentions `node:module`, `node:fs`, `node:path`, `node:url` and
`node:crypto`, behind a check that only runs them in Node. Bundlers only need
to leave them alone:

- **Vite** builds as is. It prints a "Module "node:module" has been
  externalized for browser compatibility" warning that you can ignore.
- **webpack 5** fails with `UnhandledSchemeError: Reading from "node:module"`
  unless you ignore those imports:

  ```js
  // webpack.config.js
  plugins: [new webpack.IgnorePlugin({ resourceRegExp: /^node:/ })],
  ```

The API uses `Buffer`, which browsers don't have. Install one as a global,
for example from the [`buffer`](https://www.npmjs.com/package/buffer)
package, before you create an engine:

```typescript
import { Buffer } from "buffer";
import { LuaEngine } from "lua-redis-wasm";

Object.assign(globalThis, { Buffer });

const engine = await LuaEngine.createStandalone();
engine.eval("return 1 + 1"); // 2
```

A bundler plugin that provides Node's `Buffer` globally works too.

## Reply values

Script results and host replies use one type, `ReplyValue`:

```typescript
type ReplyValue =
  | null // Lua nil / Redis null
  | number // integer (safe range)
  | bigint // integer outside the safe range
  | boolean // RESP3 boolean
  | Buffer // bulk string
  | { ok: Buffer } // status reply, e.g. +OK
  | { err: Buffer; code?: Buffer; meta?: ReplyErrorMeta } // error reply
  | { double: number } // RESP3 double
  | { big_number: Buffer } // RESP3 big number
  | { verbatim_string: { format: Buffer; string: Buffer } } // RESP3 verbatim string
  | { map: [ReplyValue, ReplyValue][] } // RESP3 map
  | { set: ReplyValue[] } // RESP3 set
  | ReplyValue[]; // array
```

How Lua values come back, as in Redis:

| Lua value | Result |
|---|---|
| `nil`, or no `return` | `null` |
| number | integer, truncated (`3.7` → `3`); a `bigint` outside JavaScript's safe integer range (`2^62` → `4611686018427387904n`) |
| string | `Buffer` |
| `true` / `false` | `1` / `null` (RESP3 after `redis.setresp(3)`: `true` / `false`) |
| array table | array, up to the first `nil` |
| `{ok='...'}` / `redis.status_reply(...)` | `{ ok }` |
| `{err='...'}` / `redis.error_reply(...)` | `{ err, code? }` |
| `{double=}`, `{map=}`, `{set=}`, `{big_number=}`, `{verbatim_string=}` | the matching RESP3 variant |
| function, coroutine, userdata (e.g. `cjson.null`) | `null`, at any depth |

Status replies from your host stay tables inside the script:
`redis.call('SET', 'k', 'v')` gives `{ok='OK'}`, and
`redis.call('SET', 'k', 'v').ok` is `'OK'`.

Typed tables such as `{double=1.5}` and `{map={...}}` come back typed even if
the script never called `redis.setresp(3)`, as in Redis. If you serve RESP2
clients, convert them yourself: Redis sends a RESP2 client a bulk string for
`double`, `big_number` and `verbatim_string`, a flat key/value array for `map`,
and a plain array for `set`.

To tell reply types apart:

```typescript
function describe(reply: ReplyValue): string {
  if (reply === null) return "nil";
  if (typeof reply === "number" || typeof reply === "bigint") return `integer ${reply}`;
  if (typeof reply === "boolean") return `boolean ${reply}`;
  if (Buffer.isBuffer(reply)) return `bulk string ${reply.toString()}`;
  if (Array.isArray(reply)) return `array of ${reply.length}`;
  if ("ok" in reply) return `status ${reply.ok.toString()}`;
  if ("err" in reply) return `error ${reply.err.toString()}`;
  return `RESP3 ${Object.keys(reply)[0]}`;
}
```

## API reference

| Export | Description |
|---|---|
| `LuaEngine.create(options)` | Load the module and create an engine with host callbacks. Options: `host` (required), `limits`, `profile`, `compat`, `redisProps`, `wasmPath`, `wasmBytes`, `modulePath`. |
| `LuaEngine.createStandalone(options?)` | Same, without host callbacks. |
| `engine.eval(script)` | Run a script; returns a `ReplyValue`. |
| `engine.evalWithArgs(script, keys, args)` | Run a script with `KEYS` and `ARGV`. |
| `engine.reset()` | Replace the Lua VM with a fresh one. |
| `engine.dispose()` | Release the engine. |
| `engine.getLimits()` | The limits the engine was created with. |
| `LuaEngine.defaultWasmPath()`, `LuaEngine.defaultModulePath()` | Location of the bundled `redis_lua.wasm` / `redis_lua.mjs`. |
| `load(options?)` | Load the module; returns a `LuaWasmModule` with `create(host)` and `createStandalone()`. |
| `LuaWasmModule` | What `load()` returns: `create(host)` / `createStandalone()` make its one engine; static `defaultWasmPath()` / `defaultModulePath()`. |
| `WasmFault` | Error class for a fault inside the WebAssembly module. |
| `encodeReply(value)`, `decodeReplyBuffer(buffer)`, `encodeArgs(args)` | Low-level helpers for the [binary ABI](docs/abi.md) encoding of replies and argument arrays. Most applications don't need them. |
| `LuaWasmEngine` | Deprecated alias of `LuaEngine`; use `LuaEngine` instead. |

Types: `EngineOptions`, `StandaloneOptions`, `LoadOptions`, `EngineLimits`,
`RedisHost`, `RedisCallHandler`, `RedisCallContext`, `RedisLogHandler`,
`ReplyValue`, `ReplyErrorMeta`, `CompatProfile`, `CompatOverrides`,
`RedisProp`, `RedisProps`.

## Included Lua libraries

- **cjson**: JSON encoding and decoding
- **cmsgpack**: MessagePack serialization
- **struct**: binary data packing and unpacking
- **bit**: bitwise operations
- Lua 5.1's `base`, `table`, `string` and `math` libraries, plus `coroutine`
  and, depending on the profile, a sandboxed `os` (`os.clock` only)

As in Redis, there is no file or network access, `os` (where the profile
enables it) has only `os.clock`, and scripts cannot create or change globals.

## Compatibility

| Feature | Status |
|---|---|
| Redis version target | 7.x by default; Redis 6.2–8.0 and Valkey 8.0–9.0 via `profile` |
| Lua version | 5.1 |
| Binary-safe strings | Yes |
| `redis.call` / `redis.pcall` | Yes |
| `redis.log`, `redis.sha1hex`, `redis.error_reply`, `redis.status_reply` | Yes |
| `redis.setresp` / RESP3 replies | Yes (no RESP3 push) |
| Standard Lua libraries | Yes |
| Redis Lua modules (cjson, etc.) | Yes |
| Debug / REPL helpers | No |
| Redis Modules API | Not yet |

## Upgrading from 1.x

Version 2.0 changes some behavior your host can see. Most applications only
need to:

1. Replace `LuaWasmEngine` with `LuaEngine` (the old name still works but is
   deprecated).
2. Remove `maxMemoryBytes` from `limits`, and pass whole, non-negative numbers
   for the other limits.
3. Check your error handling: `code` can be missing, a string error's code is
   always `ERR`, and scripts now see Redis 7 error tables. To keep 1.x-style
   string errors, use `profile: "redis-6.2"` or `compat: { tableErrors: false }`.

The full list, with what to do for each item, is in the
[CHANGELOG's breaking changes](CHANGELOG.md#breaking-changes).

## Documentation

- [Host interface](docs/host-interface.md): the callbacks in detail, call context, failures
- [Errors](docs/errors.md): error replies, codes, `meta`, errors inside scripts, exceptions
- [Resource limits](docs/limits.md): fuel, memory, stack and nesting limits
- [Compatibility](docs/compat.md): profiles, sandbox rules, per-version wording
- [Binary ABI](docs/abi.md): the WebAssembly interface, for contributors
- [Limits and compatibility summary](docs/limits-compat.md)

## Building from source

Clone with submodules (the Lua sources come from the `vendor/valkey`
submodule): `git clone --recursive`, or `git submodule update --init --recursive`.
Building the WebAssembly module needs Docker (it runs Emscripten in a
container).

```bash
npm ci

npm run build           # WASM + TypeScript + copy the .wasm into dist/
npm run build:wasm      # WASM only (Docker)
npm run build:ts        # TypeScript only

npm test                # rebuild the WASM, then run all tests
npm run test:skip-wasm  # run all tests against the current WASM build
npm run smoke           # native C smoke tests (Docker)

# a single test file
node --test --test-timeout=60000 --import tsx test/engine.test.ts
```

## Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details on:

- How to report bugs
- How to suggest enhancements
- Development setup
- Pull request process
- Coding standards

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before contributing.

## Security

Security is important to us. If you discover a security vulnerability, please follow our [Security Policy](SECURITY.md) for responsible disclosure.

For general security considerations when using lua-redis-wasm, see the [Security Guide](SECURITY.md#security-considerations).

## Support

- **Issues and questions**: [GitHub Issues](https://github.com/fatal10110/lua-redis-wasm/issues)
- **Documentation**: [docs/](docs/)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a list of changes in each release.

## License

This package is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.

### Third-Party Licenses

The WASM module is built from C sources vendored from
[Valkey](https://github.com/valkey-io/valkey) 8.0.11 (the `vendor/valkey`
submodule, pinned to a release tag), and parts of this project's C code are
derived from Valkey / Redis 7.2.4 and Redis 6.2. It includes third-party code
under the BSD 3-Clause License:

- **Valkey / Redis 7.2.4** (derived scripting code, Lua core modifications, `rand.c`) -
  Copyright (C) 2006-2020 Redis Ltd., (C) 2024-present Valkey contributors
- **Redis 6.2** (derived `redis-6.2` profile error behavior) -
  Copyright (C) 2009-2012 Salvatore Sanfilippo, Redis Ltd.

under the MIT License:

- **Lua 5.1** - Copyright (C) 1994-2012 Lua.org, PUC-Rio
- **lua_cjson**, **strbuf**, **fpconv** - Copyright (C) 2010-2012 Mark Pulford
- **lua_cmsgpack** - Copyright (C) 2012 Redis Ltd.
- **lua_struct** - Copyright (C) 2010-2018 Lua.org, PUC-Rio
- **lua_bit** - Copyright (C) 2008-2012 Mike Pall

and under the Boost Software License 1.0:

- **fpconv_dtoa** - Copyright (C) 2013-2019 night-shift, (C) 2009 Florian Loitsch,
  (C) 2021 Redis Ltd.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for full license texts.

## Acknowledgments

- Redis and Valkey teams for the Lua integration design
- Emscripten project for WebAssembly tooling
- Contributors and maintainers of the included Lua libraries
