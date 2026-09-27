/**
 * Compile errors and LuaEngine.compile() (#94). Redis replies, on every version
 * (Redis 6.2 to 8.0, Valkey 8.0 and 9.0, read from real servers):
 *
 *   EVAL "return +" 0 / SCRIPT LOAD "return +"
 *   -ERR Error compiling script (new function): user_script:1: unexpected symbol near '+'
 *
 * with no "script: <sha>, on @user_script:N." suffix (luaCreateFunction in
 * Valkey 8.0's src/eval.c). The engine flags the error where the load fails
 * (meta.kind "compile") and keeps Lua's message in `err`; the host adds the
 * wording. compile() only loads the script, for the host's SCRIPT LOAD.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load, LuaEngine } from "../src/index.js";
import type { CompatProfile, RedisHost, ReplyError, ReplyValue } from "../src/types.js";
import type { WasmExports } from "../src/loader-core.js";

const PROFILES: Array<CompatProfile | undefined> = [undefined, "redis-6.2", "redis-7.0", "redis-8.0", "valkey-9.0"];

const SYNTAX = "return +";
const SYNTAX_MESSAGE = "user_script:1: unexpected symbol near '+'";
const SYNTAX_LINE_2 = "local a = 1\nreturn +";
const NESTED_EVAL = "nested eval is not supported: a script is already running";

function sha1(script: string | Buffer): string {
  return createHash("sha1").update(script).digest("hex");
}

function host(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall: () => ({ ok: Buffer.from("OK") }),
    redisPcall: () => ({ ok: Buffer.from("OK") }),
    log: () => {},
    ...overrides,
  };
}

/** The compile error reply eval and compile() give for `script`. */
function compileError(script: string | Buffer, message: string, line: number): ReplyError {
  return {
    err: Buffer.from(message),
    code: Buffer.from("ERR"),
    meta: { kind: "compile", line, sha: sha1(script) },
  };
}

function asError(value: ReplyValue): ReplyError {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  return value as ReplyError;
}

function exportsOf(engine: LuaEngine): WasmExports {
  return (engine as unknown as { exports: WasmExports }).exports;
}

for (const profile of PROFILES) {
  const name = profile ?? "default";

  test(`compile errors (${name}): eval flags a script that fails to compile`, async () => {
    const engine = (await load({ profile })).create(host());
    assert.deepEqual(engine.eval(SYNTAX), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
    assert.deepEqual(engine.evalWithArgs(SYNTAX, ["k"], ["a"]), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
    assert.deepEqual(
      engine.eval(SYNTAX_LINE_2),
      compileError(SYNTAX_LINE_2, "user_script:2: unexpected symbol near '+'", 2),
    );
    assert.deepEqual(
      engine.eval("return 1 +"),
      compileError("return 1 +", "user_script:1: unexpected symbol near '<eof>'", 1),
    );
    assert.equal(engine.eval("return 1 + 1"), 2);
  });

  test(`compile errors (${name}): compile() gives the same reply as eval`, async () => {
    const engine = (await load({ profile })).create(host());
    assert.deepEqual(engine.compile(SYNTAX), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
    assert.deepEqual(engine.compile(SYNTAX), engine.eval(SYNTAX));
    assert.deepEqual(engine.compile(SYNTAX_LINE_2), engine.eval(SYNTAX_LINE_2));
    assert.equal(engine.compile("return 1 + 1"), null);
    assert.equal(engine.eval("return 1 + 1"), 2);
  });

  test(`compile errors (${name}): a runtime error with the same text is not flagged`, async () => {
    const engine = (await load({ profile })).create(host());
    const runtime = `error("${SYNTAX_MESSAGE}", 0)`;
    assert.deepEqual(engine.eval(runtime), {
      err: Buffer.from(SYNTAX_MESSAGE),
      code: Buffer.from("ERR"),
      meta: { line: 1, sha: sha1(runtime) },
    });
    // A chunk loadstring fails to compile is the script's runtime error.
    const rethrown = "local f, e = loadstring('return +') error(e, 0)";
    const reply = asError(engine.eval(rethrown));
    assert.equal(reply.err.toString(), `[string "return +"]:1: unexpected symbol near '+'`);
    assert.equal(reply.meta?.kind, undefined);
    assert.equal(asError(engine.eval(`error({err="${SYNTAX_MESSAGE}"})`)).meta?.kind, undefined);
    // Only the load of the script itself is checked by compile().
    assert.equal(engine.compile(runtime), null);
    assert.equal(engine.compile(rethrown), null);
  });
}

test("compile(): success returns null and a following eval runs the script", async () => {
  const engine = await LuaEngine.create({ host: host() });
  const script = "return {KEYS[1], ARGV[1], redis.call('PING')}";
  assert.equal(engine.compile(script), null);
  assert.deepEqual(engine.evalWithArgs(script, ["k"], ["a"]), [
    Buffer.from("k"),
    Buffer.from("a"),
    { ok: Buffer.from("OK") },
  ]);
  assert.equal(engine.compile(Buffer.from("return 1")), null);
  assert.equal(engine.compile(new TextEncoder().encode("return 1")), null);
  assert.equal(engine.compile(""), null);
});

test("compile(): the script does not run and the Lua VM is left as it was", async () => {
  const calls: string[] = [];
  const engine = await LuaEngine.create({
    host: host({
      redisCall: (args) => (calls.push(`call ${args[0]}`), { ok: Buffer.from("OK") }),
      redisPcall: (args) => (calls.push(`pcall ${args[0]}`), { ok: Buffer.from("OK") }),
      log: (_level, message) => void calls.push(`log ${message}`),
      onSetResp: (version) => void calls.push(`setresp ${version}`),
    }),
    limits: { maxFuel: 10_000 },
  });
  const scripts = [
    "redis.call('SET', 'k', 'v') redis.pcall('DEL', 'k') return 1",
    "redis.log(redis.LOG_WARNING, 'hi')",
    "redis.setresp(3)",
    "x = 1",
    "rawset(_G, 'y', 1)",
    "cjson.encode_max_depth(1)",
    "error('boom')",
    "return undefined_global",
    "while true do end",
  ];
  for (const script of scripts) {
    assert.equal(engine.compile(script), null, script);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(engine.eval("return {rawget(_G, 'x'), rawget(_G, 'y')}"), []);
  assert.deepEqual(engine.eval("return cjson.encode({{1}})"), Buffer.from("[[1]]"));
  assert.match(asError(engine.eval("while true do end")).err.toString(), /Script killed by fuel limit/);
  // Many compiles leave nothing behind on the Lua stack.
  for (let i = 0; i < 1000; i++) {
    engine.compile(i % 2 ? `return ${i}` : SYNTAX);
  }
  assert.equal(engine.eval("return 7"), 7);
  assert.deepEqual(engine.evalWithArgs("return {KEYS[1], ARGV[1]}", ["k"], ["a"]), [Buffer.from("k"), Buffer.from("a")]);
});

test("compile(): refused while a script runs, like eval", async () => {
  const nested: ReplyValue[] = [];
  let engine!: LuaEngine;
  engine = await LuaEngine.create({
    host: host({
      redisCall: () => {
        nested.push(engine.compile("return 1"), engine.compile(SYNTAX));
        return { ok: Buffer.from("OK") };
      },
    }),
  });
  assert.deepEqual(engine.eval("return redis.call('PING')"), { ok: Buffer.from("OK") });
  assert.equal(nested.length, 2);
  for (const reply of nested) {
    assert.deepEqual(reply, { err: Buffer.from(NESTED_EVAL), code: Buffer.from("ERR") });
  }
  assert.equal(engine.compile("return 1"), null);
  assert.deepEqual(engine.compile(SYNTAX), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
});

test("compile(): throws after dispose()", async () => {
  const engine = await LuaEngine.createStandalone();
  assert.equal(engine.compile("return 1"), null);
  engine.dispose();
  assert.throws(() => engine.compile("return 1"), /LuaEngine has been disposed/);
  assert.throws(() => engine.compile(SYNTAX), /LuaEngine has been disposed/);
});

test("compile(): works after reset() and replies like eval without a VM", async () => {
  const engine = await LuaEngine.createStandalone({ profile: "redis-6.2" });
  engine.reset();
  assert.equal(engine.compile("return 1"), null);
  assert.deepEqual(engine.compile(SYNTAX), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
  exportsOf(engine)._close_vm!();
  const noVm = { err: Buffer.from("Lua VM not initialized"), code: Buffer.from("ERR") };
  assert.deepEqual(engine.compile("return 1"), noVm);
  assert.deepEqual(engine.eval("return 1"), noVm);
  engine.reset();
  assert.equal(engine.compile("return 1"), null);
  assert.equal(engine.eval("return 1"), 1);
});

test("compile(): works in a standalone engine", async () => {
  const engine = await LuaEngine.createStandalone();
  assert.equal(engine.compile("return redis.call('PING')"), null);
  assert.deepEqual(engine.compile(SYNTAX), compileError(SYNTAX, SYNTAX_MESSAGE, 1));
});

test("compile(): binary-safe script input", async () => {
  const engine = await LuaEngine.createStandalone();
  const ok = Buffer.from("return 'a\0b\xff'", "latin1");
  assert.equal(engine.compile(ok), null);
  assert.deepEqual(engine.eval(ok), Buffer.from("a\0b\xff", "latin1"));
  // The NUL is part of the script: the error is past it, not cut there.
  const bad = Buffer.from("local s = 'a\0b'\nreturn +", "latin1");
  const expected = compileError(bad, "user_script:2: unexpected symbol near '+'", 2);
  assert.deepEqual(engine.compile(bad), expected);
  assert.deepEqual(engine.eval(bad), expected);
  assert.deepEqual(engine.compile(new Uint8Array(bad)), expected);
});

test("compile(): no script-size limit but the heap; the limits do not apply", async () => {
  const engine = await LuaEngine.createStandalone({ limits: { maxArgBytes: 1, maxReplyBytes: 1, maxFuel: 1 } });
  const big = `return ${"1 + ".repeat(50_000)}1`;
  assert.equal(engine.compile(big), null);
  assert.throws(() => engine.compile(Buffer.alloc(80 * 1024 * 1024, 0x20)), RangeError);
  assert.equal(engine.compile("return 1"), null);
});

test("compile errors: running out of memory while loading is a compile error, like Redis", async () => {
  // Redis replies "Error compiling script (new function): <message>" for any
  // luaL_loadbuffer failure, LUA_ERRMEM included (luaCreateFunction).
  const engine = await LuaEngine.createStandalone();
  const huge = `return "${"x".repeat(16 * 1024 * 1024)}"`;
  const expected = compileError(huge, "not enough memory", 1);
  assert.deepEqual(engine.compile(huge), expected);
  assert.deepEqual(engine.eval(huge), expected);
  assert.equal(engine.compile("return 1"), null);
  assert.equal(engine.eval("return 1"), 1);
});

test("compile(): a WASM binary without the compile export is reported", async () => {
  const engine = await LuaEngine.createStandalone();
  const exports = exportsOf(engine);
  const real = exports._compile;
  delete exports._compile;
  assert.throws(() => engine.compile("return 1"), /not supported by this WASM binary/);
  exports._compile = real;
  assert.equal(engine.compile("return 1"), null);
});
