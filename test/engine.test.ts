/**
 * Comprehensive unit tests for LuaEngine.
 * Tests cover: basic eval, evalWithArgs, host callbacks, error handling, limits, and standalone mode.
 */
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { load, LuaWasmModule } from "../src/index.js";
import { LuaWasmEngine, makePropsHandler } from "../src/engine.js";
import { encodeRedisProps } from "../src/codec.js";
import type { ReplyValue, RedisHost } from "../src/types.js";
import type { WasmExports } from "../src/loader-core.js";

// Helper to resolve WASM path (checks dist/ first, then wasm/build/)
async function resolveWasmPath(): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), "dist/redis_lua.wasm"),
    path.resolve(process.cwd(), "wasm/build/redis_lua.wasm")
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error(`WASM file not found. Checked: ${candidates.join(", ")}`);
}

function bufferEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.compare(b) === 0;
}

// Simple host implementation for testing
function createTestHost(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall(args) {
      const cmd = args[0]?.toString("utf8").toUpperCase();
      if (cmd === "PING") return { ok: Buffer.from("PONG") };
      if (cmd === "GET" && args[1]) return Buffer.from(`value:${args[1].toString()}`);
      if (cmd === "SET") return { ok: Buffer.from("OK") };
      if (cmd === "ECHO" && args[1]) return Buffer.from(args[1]);
      if (cmd === "INCR") return 1;
      if (cmd === "MGET") return args.slice(1).map((k) => Buffer.from(`v:${k.toString()}`));
      if (cmd === "THROW") throw new Error("ERR intentional error");
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args) {
      try {
        return this.redisCall(args);
      } catch (err) {
        return { err: Buffer.from(err instanceof Error ? err.message : String(err)) };
      }
    },
    log() {},
    ...overrides
  };
}

// =============================================================================
// Basic eval() tests
// =============================================================================

test("eval: returns number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 42");
  assert.equal(result, 42);
});

test("eval: returns negative number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return -100");
  assert.equal(result, -100);
});

test("eval: returns float as integer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // Lua 5.1 has no separate integer type, math.floor returns number
  const result = engine.eval("return math.floor(3.7)");
  assert.equal(result, 3);
});

test("eval: arithmetic operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  assert.equal(engine.eval("return 10 + 5"), 15);
  assert.equal(engine.eval("return 10 - 5"), 5);
  assert.equal(engine.eval("return 10 * 5"), 50);
  assert.equal(engine.eval("return 10 / 5"), 2);
  assert.equal(engine.eval("return 10 % 3"), 1);
  assert.equal(engine.eval("return 2 ^ 10"), 1024);
});

test("eval: returns string as Buffer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 'hello world'");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString("utf8"), "hello world");
});

test("eval: returns nil as null", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return nil");
  assert.equal(result, null);
});

test("redis.call: null reply becomes Lua false (not nil)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost({ redisCall: () => null, redisPcall: () => null }));
  // Real Redis maps a RESP null reply to Lua false.
  assert.equal((engine.eval("return type(redis.call('GET','x'))") as Buffer).toString(), "boolean");
  assert.equal(engine.eval("if redis.call('GET','x') == false then return 1 else return 0 end"), 1);
});

test("redis.call: null nested in array reply becomes false", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(
    createTestHost({ redisCall: () => [Buffer.from("a"), null], redisPcall: () => [Buffer.from("a"), null] })
  );
  assert.equal(engine.eval("local r = redis.call('MGET','a','b'); return type(r[2])").toString(), "boolean");
});

test("eval: returns empty table as empty array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {}");
  assert.ok(Array.isArray(result));
  assert.equal((result as unknown[]).length, 0);
});

test("eval: returns table as array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {1, 2, 3}");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [1, 2, 3]);
});

test("eval: returns nested tables", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {{1, 2}, {3, 4}}");
  assert.ok(Array.isArray(result));
  assert.deepEqual(result, [[1, 2], [3, 4]]);
});

test("eval: returns mixed array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {1, 'hello', nil, 4}") as ReplyValue[];
  assert.ok(Array.isArray(result));
  assert.equal(result[0], 1);
  assert.ok(Buffer.isBuffer(result[1]));
  // nil in middle of array terminates iteration in Lua table
});

test("eval: accepts Buffer as script", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = Buffer.from("return 99");
  const result = engine.eval(script);
  assert.equal(result, 99);
});

test("eval: accepts Uint8Array as script", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = new TextEncoder().encode("return 77");
  const result = engine.eval(script);
  assert.equal(result, 77);
});

test("eval: Lua syntax error returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return 1 +");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("eval: Lua runtime error returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("error('boom')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("eval: Lua error format matches Redis format", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = "redis.set('key', 'value')"; // redis.set doesn't exist, only redis.call
  const result = engine.eval(script);

  assert.ok(result && typeof result === "object" && "err" in result);
  // Lua runtime error: err is Lua's raw message (line prefix, no decoration); the
  // engine adds no prose, only line/sha metadata for the host to render with.
  const r = result as { err: Buffer; meta?: { line: number; sha: string } };
  const errStr = r.err.toString("utf8");
  assert.ok(errStr.startsWith("user_script:1:"), `Error should start with 'user_script:1:', got: ${errStr}`);
  assert.ok(!errStr.includes(" script: "), `Raw err should not be decorated, got: ${errStr}`);
  assert.equal(r.meta?.line, 1);
  assert.match(r.meta?.sha ?? "", /^[a-f0-9]{40}$/);
});

test("eval: Lua error on different line includes correct line number", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const script = `
local x = 1
local y = 2
redis.nonexistent()  -- line 4
`;
  const result = engine.eval(script);

  assert.ok(result && typeof result === "object" && "err" in result);
  const r = result as { err: Buffer; meta?: { line: number } };

  // Raw err references line 4; meta carries it for the host to decorate.
  assert.ok(r.err.toString("utf8").startsWith("user_script:4:"), `Error should start with 'user_script:4:', got: ${r.err}`);
  assert.equal(r.meta?.line, 4);
});

test("eval: reading a nonexistent global is classified as global-read", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("print('a')") as {
    err: Buffer;
    meta?: { kind: string; name: string; line: number; sha: string };
  };

  assert.ok(result && typeof result === "object" && "err" in result);
  // Engine emits a machine kind, not wording; no marker leaks into err.
  assert.ok(!result.err.toString("utf8").includes("__RLUA_E__"), `marker leaked: ${result.err}`);
  assert.equal(result.meta?.kind, "global-read");
  assert.equal(result.meta?.name, "print");
  assert.equal(result.meta?.line, 1);
  assert.match(result.meta?.sha ?? "", /^[a-f0-9]{40}$/);
});

test("eval: Redis-allowed builtins are exposed (issue #16)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // These are on Redis's allow lists (lua_builtins_allow_list / libraries_allow_list);
  // we must not over-restrict them.
  assert.equal(engine.eval("return type(loadstring)").toString(), "function");
  assert.equal(engine.eval("return type(load)").toString(), "function");
  assert.equal(engine.eval("return type(collectgarbage)").toString(), "function");
  assert.equal(engine.eval("return type(gcinfo)").toString(), "function");
  assert.equal(engine.eval("return type(os)").toString(), "table");
  // os is sandboxed to os.clock only (vendored loslib sandbox_syslib).
  assert.equal(engine.eval("return type(os.clock)").toString(), "function");
  assert.equal(engine.eval("return type(os.execute)").toString(), "nil");
});

test("eval: writing a global is blocked by the native readonly flag", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  // Write protection is the patched Lua's native readonly flag (as in Redis):
  // the VM raises its own message, which passes through. No engine kind.
  for (const script of ["x = 5", "redis = 5", "KEYS = 5", "tostring = 1"]) {
    const result = engine.eval(script) as {
      err: Buffer;
      code?: Buffer;
      meta?: { kind?: string; line: number; sha: string };
    };
    assert.ok(result && typeof result === "object" && "err" in result, `not blocked: ${script}`);
    assert.match(
      result.err.toString("utf8"),
      /Attempt to modify a readonly table/,
      `${script} -> ${result.err}`,
    );
    assert.equal(result.meta?.kind, undefined, `${script} should have no kind`);
    assert.equal(result.code?.toString("utf8"), "ERR");
  }
});

test("eval: reassigning an existing global is blocked (regression: __newindex gap)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // A fresh engine: KEYS exists as a real global, so a __newindex metatable would
  // miss this write. The readonly flag catches it, and the corruption does not
  // leak into the next script.
  const reassign = engine.eval("KEYS = 5\nreturn 1");
  assert.ok(reassign && typeof reassign === "object" && "err" in reassign, `KEYS reassign not blocked`);
  assert.equal(engine.eval("return type(KEYS)").toString(), "table");
});

test("eval: setfenv/getfenv are removed (sandbox-escape vectors)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // Redis removes these via lua_builtins_deprecated; they let a script swap its
  // environment and reach the real global table, bypassing globals protection.
  // With them gone, globals protection turns access into a global-read error.
  for (const name of ["setfenv", "getfenv"]) {
    const r = engine.eval(`return ${name}`) as { err: Buffer; meta?: { kind: string; name: string } };
    assert.ok(r && typeof r === "object" && "err" in r, `${name} still reachable`);
    assert.equal(r.meta?.kind, "global-read", `${name} -> ${JSON.stringify(r)}`);
    assert.equal(r.meta?.name, name);
  }
});

test("eval: library tables are locked recursively like Redis", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // The whole globals tree is readonly (redis, string, cjson, table, ...), not
  // just the globals table -- so mutating a library field is blocked too.
  for (const script of ["redis.call = 5", "string.len = nil", "cjson.encode = 1", "table.insert = 1"]) {
    const r = engine.eval(script);
    assert.ok(r && typeof r === "object" && "err" in r, `not blocked: ${script}`);
    assert.match(
      (r as { err: Buffer }).err.toString("utf8"),
      /Attempt to modify a readonly table/,
      `${script} -> ${JSON.stringify(r)}`,
    );
  }
  // Reads/calls on those tables still work.
  assert.equal(engine.eval("return type(redis.call)").toString(), "function");
});

test("eval: non-integer number return is truncated to integer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  assert.equal(engine.eval("return 3.7"), 3);
  assert.equal(engine.eval("return 3.3"), 3);
});

test("eval: script with no return value replies with nil", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  assert.equal(engine.eval("local a = 1"), null);
  assert.equal(engine.eval("return"), null);
});

test("eval: table with both ok and err is an error (err wins)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return {ok='STAT', err='ERRR'}");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.equal((result as { err: Buffer }).err.toString("utf8"), "ERRR");
});

test("redis.error_reply: prepends ERR to lowercase multi-word messages", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const lower = engine.eval("return redis.error_reply('my bad')") as { err: Buffer; code?: Buffer };
  assert.equal(lower.err.toString("utf8"), "my bad");
  assert.equal(lower.code?.toString("utf8"), "ERR");

  // Single-word still gets the prefix.
  const word = engine.eval("return redis.error_reply('foo')") as { err: Buffer; code?: Buffer };
  assert.equal(word.err.toString("utf8"), "foo");
  assert.equal(word.code?.toString("utf8"), "ERR");

  // Existing uppercase code is left untouched.
  const coded = engine.eval("return redis.error_reply('WRONGTYPE x')") as { err: Buffer; code?: Buffer };
  assert.equal(coded.err.toString("utf8"), "x");
  assert.equal(coded.code?.toString("utf8"), "WRONGTYPE");
});

test("redis.setresp: RESP2 is accepted and returns no value", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return redis.setresp(2)"), null);
});

test("redis.setresp: enables RESP3 return conversions for the current script", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const result = engine.eval(`
    redis.setresp(3)
    return {
      true,
      false,
      {double=3.5},
      {big_number='123456789012345678901234567890'},
      {verbatim_string={format='txt', string='hello'}},
      {map={a=1,b='two'}},
      {set={a=true,b=true}}
    }
  `) as ReplyValue[];

  assert.equal(result[0], true);
  assert.equal(result[1], false);
  assert.deepEqual(result[2], { double: 3.5 });
  assert.deepEqual(result[3], { big_number: Buffer.from("123456789012345678901234567890") });
  assert.deepEqual(result[4], {
    verbatim_string: { format: Buffer.from("txt"), string: Buffer.from("hello") },
  });

  const map = (result[5] as { map: [ReplyValue, ReplyValue][] }).map
    .map(([key, value]) => [
      Buffer.isBuffer(key) ? key.toString("utf8") : key,
      Buffer.isBuffer(value) ? value.toString("utf8") : value,
    ])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  assert.deepEqual(map, [["a", 1], ["b", "two"]]);

  const set = (result[6] as { set: ReplyValue[] }).set
    .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : value)
    .sort();
  assert.deepEqual(set, ["a", "b"]);

  assert.equal(engine.eval("return true"), 1);
});

test("redis.setresp: rejects unsupported protocol versions", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const result = engine.eval("return redis.setresp(4)") as {
    err: Buffer;
    code?: Buffer;
    meta?: { line: number };
  };

  assert.ok(result && typeof result === "object" && "err" in result);
  assert.equal(result.code?.toString("utf8"), "ERR");
  assert.match(result.err.toString("utf8"), /RESP version must be 2 or 3/);
  assert.equal(result.meta?.line, 1);
});

test("redis.setresp: notifies the host of the new protocol version", async () => {
  await resolveWasmPath();
  const module = await load();
  const seen: number[] = [];
  const engine = module.create(createTestHost({
    onSetResp: (version) => seen.push(version),
  }));

  engine.eval("redis.setresp(3); redis.setresp(2)");
  assert.deepEqual(seen, [3, 2]);
});

test("redis.setresp: missing onSetResp host hook is a no-op", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  // No onSetResp provided; eval must not throw.
  assert.equal(engine.eval("redis.setresp(3); return true"), true);
});

test("redis.setresp: decodes RESP3 host replies for redis.call", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost({
    redisCall: () => ({
      map: [[
        Buffer.from("score"),
        { double: 2.5 },
      ], [
        Buffer.from("tags"),
        { set: [Buffer.from("hot")] },
      ]],
    }),
  }));

  assert.deepEqual(engine.eval("redis.setresp(3); local r=redis.call('X'); return {double=r.map.score.double}"), {
    double: 2.5,
  });
  assert.equal(engine.eval("redis.setresp(3); local r=redis.call('X'); return r.map.tags.set.hot"), true);
});

test("eval: coroutine library remains available", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  assert.equal((engine.eval("return type(coroutine)") as Buffer).toString(), "table");
});

test("redis.call: non-string/number argument is classified as command-arg-type", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('set','k',true)") as {
    err: Buffer;
    meta?: { kind?: string; name?: string; line: number };
  };
  assert.ok(result && typeof result === "object" && "err" in result);
  // Engine forwards a machine kind, not Redis's wording; no marker leaks.
  assert.ok(!result.err.toString("utf8").includes("__RLUA_E__"), `marker leaked: ${result.err}`);
  assert.equal(result.meta?.kind, "command-arg-type");
  assert.equal(result.meta?.name, undefined);
  assert.equal(result.meta?.line, 1); // call site is line 1
});

test("redis.call: command error reports the call-site line (issue #13)", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  // The command error string carries no `user_script:N:` prefix (raised via
  // lua_error from C). Redis's error handler walks past the C frame and reports
  // the script line that called redis.call; the engine must match.
  const script = `
local a = 1
local b = 2
return redis.call('BOGUS')  -- line 4
`;
  const result = engine.eval(script) as { err: Buffer; meta?: { line: number } };
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.equal(result.meta?.line, 4);
});

test("redis.call: coded command error keeps its code and call-site line", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(
    createTestHost({ redisCall: () => ({ err: Buffer.from("WRONGTYPE Operation against a key") }) }),
  );
  const result = engine.eval("local a = 1\nreturn redis.call('GET','x')  -- line 2") as {
    err: Buffer;
    code?: Buffer;
    meta?: { line: number };
  };
  // The line travels out-of-band, so splitting the error code from the message is
  // unaffected: code stays WRONGTYPE and the line is the call site (2), not 1.
  assert.equal(result.code?.toString("utf8"), "WRONGTYPE");
  assert.equal(result.err.toString("utf8"), "Operation against a key");
  assert.equal(result.meta?.line, 2);
});

// =============================================================================
// evalWithArgs() tests
// =============================================================================

test("evalWithArgs: KEYS injection", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return KEYS[1]",
    [Buffer.from("mykey")],
    []
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "mykey");
});

test("evalWithArgs: ARGV injection", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return ARGV[1]",
    [],
    [Buffer.from("myarg")]
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "myarg");
});

test("evalWithArgs: multiple KEYS and ARGV", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return {KEYS[1], KEYS[2], ARGV[1], ARGV[2]}",
    [Buffer.from("k1"), Buffer.from("k2")],
    [Buffer.from("a1"), Buffer.from("a2")]
  ) as ReplyValue[];

  assert.ok(Array.isArray(result));
  assert.equal((result[0] as Buffer).toString(), "k1");
  assert.equal((result[1] as Buffer).toString(), "k2");
  assert.equal((result[2] as Buffer).toString(), "a1");
  assert.equal((result[3] as Buffer).toString(), "a2");
});

test("evalWithArgs: binary-safe KEYS/ARGV with null bytes", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const key = Buffer.from([0x00, 0x01, 0x02]);
  const arg = Buffer.from([0x03, 0x00, 0x04]);

  const result = engine.evalWithArgs(
    "return KEYS[1] .. ARGV[1]",
    [key],
    [arg]
  );

  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...(result as Buffer)], [0x00, 0x01, 0x02, 0x03, 0x00, 0x04]);
});

test("evalWithArgs: accepts strings", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs("return KEYS[1]", ["stringkey"], []);
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "stringkey");
});

test("evalWithArgs: empty KEYS and ARGV", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs("return #KEYS + #ARGV", [], []);
  assert.equal(result, 0);
});

test("evalWithArgs: KEYS length", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return #KEYS",
    [Buffer.from("a"), Buffer.from("b"), Buffer.from("c")],
    []
  );
  assert.equal(result, 3);
});

test("evalWithArgs: ARGV length", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.evalWithArgs(
    "return #ARGV",
    [],
    [Buffer.from("x"), Buffer.from("y")]
  );
  assert.equal(result, 2);
});

// =============================================================================
// redis.call() tests
// =============================================================================

test("redis.call: PING returns status", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('PING')");
  assert.ok(result && typeof result === "object" && "ok" in result);
  assert.equal((result as { ok: Buffer }).ok.toString(), "PONG");
});

test("redis.call: GET returns value", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('GET', 'foo')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "value:foo");
});

test("redis.call: SET returns OK", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('SET', 'key', 'value')");
  assert.ok(result && typeof result === "object" && "ok" in result);
});

test("redis.call: INCR returns integer", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('INCR', 'counter')");
  assert.equal(result, 1);
});

test("redis.call: MGET returns array", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('MGET', 'a', 'b')") as ReplyValue[];
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 2);
});

test("redis.call: ECHO with binary data", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('ECHO', string.char(0, 1, 0))");
  assert.ok(Buffer.isBuffer(result));
  assert.deepEqual([...(result as Buffer)], [0, 1, 0]);
});

test("redis.call: unknown command returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('UNKNOWNCMD')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("redis.call: host throwing returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.call('THROW')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("intentional"));
});

test("redis.call: receives arguments as Buffers", async () => {
  await resolveWasmPath();
  let receivedArgs: Buffer[] = [];
  const host = createTestHost({
    redisCall(args) {
      receivedArgs = args;
      return { ok: Buffer.from("OK") };
    }
  });
  const module = await load();
  const engine = module.create(host);
  engine.eval("redis.call('TEST', 'arg1', 'arg2')");

  assert.equal(receivedArgs.length, 3);
  assert.ok(Buffer.isBuffer(receivedArgs[0]));
  assert.equal(receivedArgs[0].toString(), "TEST");
  assert.equal(receivedArgs[1].toString(), "arg1");
  assert.equal(receivedArgs[2].toString(), "arg2");
});

// =============================================================================
// redis.pcall() tests
// =============================================================================

test("redis.pcall: returns error instead of throwing", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.pcall('THROW')");
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("redis.pcall: success returns normal value", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.pcall('PING')");
  assert.ok(result && typeof result === "object" && "ok" in result);
});

// =============================================================================
// redis.log() tests
// =============================================================================

test("redis.log: calls host log handler", async () => {
  await resolveWasmPath();
  let loggedLevel: number | null = null;
  let loggedMessage: Buffer | null = null;

  const host = createTestHost({
    log(level, message) {
      loggedLevel = level;
      loggedMessage = message;
    }
  });

  const module = await load();
  const engine = module.create(host);
  engine.eval("redis.log(redis.LOG_WARNING, 'test message')");

  assert.ok(loggedLevel !== null);
  assert.ok(loggedMessage !== null);
  assert.ok(Buffer.isBuffer(loggedMessage));
  assert.equal(loggedMessage.toString(), "test message");
});

// =============================================================================
// redis.sha1hex() tests
// =============================================================================

test("redis.sha1hex: computes SHA1 hash", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.sha1hex('hello')");
  assert.ok(Buffer.isBuffer(result));
  // SHA1 of "hello" is aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d
  assert.equal((result as Buffer).toString(), "aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d");
});

test("redis.sha1hex: empty string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return redis.sha1hex('')");
  assert.ok(Buffer.isBuffer(result));
  // SHA1 of empty string is da39a3ee5e6b4b0d3255bfef95601890afd80709
  assert.equal((result as Buffer).toString(), "da39a3ee5e6b4b0d3255bfef95601890afd80709");
});

// =============================================================================
// Lua standard library tests
// =============================================================================

test("Lua: string library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return string.len('hello')"), 5);
  assert.equal((engine.eval("return string.upper('hello')") as Buffer).toString(), "HELLO");
  assert.equal((engine.eval("return string.lower('HELLO')") as Buffer).toString(), "hello");
  assert.equal((engine.eval("return string.sub('hello', 2, 4)") as Buffer).toString(), "ell");
  assert.equal((engine.eval("return string.rep('ab', 3)") as Buffer).toString(), "ababab");
});

test("Lua: math library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return math.abs(-5)"), 5);
  assert.equal(engine.eval("return math.max(1, 5, 3)"), 5);
  assert.equal(engine.eval("return math.min(1, 5, 3)"), 1);
  assert.equal(engine.eval("return math.floor(3.7)"), 3);
  assert.equal(engine.eval("return math.ceil(3.2)"), 4);
});

test("Lua: math.random is deterministic and seedable", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const first = engine.eval("return math.random(100)");
  const second = engine.eval("return math.random(100)");
  assert.equal(typeof first, "number");
  assert.ok(first >= 1 && first <= 100);
  assert.notEqual(second, first);

  const seededScript = "math.randomseed(123); return {math.random(100), math.random(100)}";
  assert.deepEqual(engine.eval(seededScript), engine.eval(seededScript));

  assert.notEqual(engine.evalWithArgs("return math.random(100)", [], []), first);
});

test("Lua: table library", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const concat = engine.eval("return table.concat({'a','b','c'}, ',')");
  assert.ok(Buffer.isBuffer(concat));
  assert.equal((concat as Buffer).toString(), "a,b,c");
});

// =============================================================================
// Limits tests
// =============================================================================

test("limits: maxArgBytes enforced on evalWithArgs", async () => {
  await resolveWasmPath();
  const module = await load({ limits: { maxArgBytes: 10 } });
  const engine = module.create(createTestHost());

  // This should exceed the limit (encoded args > 10 bytes)
  const result = engine.evalWithArgs(
    "return 1",
    [Buffer.from("this-is-a-long-key")],
    [Buffer.from("this-is-a-long-arg")]
  );

  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("limit"));
});

test("limits: small args pass validation", async () => {
  await resolveWasmPath();
  const module = await load({ limits: { maxArgBytes: 1000 } });
  const engine = module.create(createTestHost());

  const result = engine.evalWithArgs(
    "return KEYS[1]",
    [Buffer.from("k")],
    []
  );

  assert.ok(Buffer.isBuffer(result));
});

test("getLimits: returns configured limits", async () => {
  await resolveWasmPath();
  const limits = {
    maxFuel: 1000000,
    maxReplyBytes: 2000000,
    maxArgBytes: 500000
  };

  const module = await load({ limits });
  const engine = module.create(createTestHost());

  const retrieved = engine.getLimits();
  assert.deepEqual(retrieved, limits);
});

test("getLimits: returns undefined when no limits set", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const retrieved = engine.getLimits();
  assert.equal(retrieved, undefined);
});

// =============================================================================
// Standalone mode tests
// =============================================================================

test("standalone: basic eval works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return 1 + 2");
  assert.equal(result, 3);
});

test("standalone: math library works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  assert.equal(engine.eval("return math.sqrt(16)"), 4);
});

test("standalone: string library works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return string.upper('test')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "TEST");
});

test("standalone: redis.call returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.call('PING')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("standalone"));
});

test("standalone: redis.pcall returns error", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.pcall('GET', 'key')");
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.ok((result as { err: Buffer }).err.toString().includes("standalone"));
});

test("standalone: redis.sha1hex still works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.eval("return redis.sha1hex('test')");
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).length, 40); // SHA1 hex is 40 chars
});

test("standalone: evalWithArgs works", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.createStandalone();
  const result = engine.evalWithArgs(
    "return KEYS[1] .. ARGV[1]",
    [Buffer.from("key")],
    [Buffer.from("arg")]
  );
  assert.ok(Buffer.isBuffer(result));
  assert.equal((result as Buffer).toString(), "keyarg");
});

// =============================================================================
// Static method tests
// =============================================================================

test("defaultWasmPath: returns a string path", () => {
  const wasmPath = LuaWasmModule.defaultWasmPath();
  assert.equal(typeof wasmPath, "string");
  assert.ok(wasmPath.endsWith(".wasm"));
});

test("defaultModulePath: returns a string path", () => {
  const modulePath = LuaWasmModule.defaultModulePath();
  assert.equal(typeof modulePath, "string");
  assert.ok(modulePath.endsWith(".mjs"));
});

// =============================================================================
// cjson library tests
// =============================================================================

test("cjson: encode object", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("return cjson.encode({a=1, b=2})");
  assert.ok(Buffer.isBuffer(result));
  const parsed = JSON.parse((result as Buffer).toString());
  assert.deepEqual(parsed, { a: 1, b: 2 });
});

test("cjson: decode string", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval("local t = cjson.decode('{\"x\":10}'); return t.x");
  assert.equal(result, 10);
});

test("cjson: roundtrip", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local orig = {name='test', count=42}
    local json = cjson.encode(orig)
    local decoded = cjson.decode(json)
    return decoded.count
  `);
  assert.equal(result, 42);
});

// =============================================================================
// cmsgpack library tests
// =============================================================================

test("cmsgpack: pack and unpack", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local packed = cmsgpack.pack({1, 2, 3})
    local unpacked = cmsgpack.unpack(packed)
    return unpacked[2]
  `);
  assert.equal(result, 2);
});

// =============================================================================
// struct library tests
// =============================================================================

test("struct: pack and unpack integers", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());
  const result = engine.eval(`
    local packed = struct.pack('>I2', 0x1234)
    local a, b = string.byte(packed, 1, 2)
    return a * 256 + b
  `);
  assert.equal(result, 0x1234);
});

// =============================================================================
// bit library tests
// =============================================================================

test("bit: operations", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  assert.equal(engine.eval("return bit.band(0xff, 0x0f)"), 0x0f);
  assert.equal(engine.eval("return bit.bor(0xf0, 0x0f)"), 0xff);
  assert.equal(engine.eval("return bit.bxor(0xff, 0x0f)"), 0xf0);
  assert.equal(engine.eval("return bit.bnot(0)"), -1);
  assert.equal(engine.eval("return bit.lshift(1, 4)"), 16);
  assert.equal(engine.eval("return bit.rshift(16, 2)"), 4);
});

// =============================================================================
// Multiple script executions
// =============================================================================

test("multiple evals: engine state persists", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  // Note: Lua global variables don't persist between evals in this implementation
  // Each eval is independent
  assert.equal(engine.eval("return 1"), 1);
  assert.equal(engine.eval("return 2"), 2);
  assert.equal(engine.eval("return 3"), 3);
});

test("multiple evalWithArgs: independent executions", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(createTestHost());

  const r1 = engine.evalWithArgs("return KEYS[1]", [Buffer.from("first")], []);
  const r2 = engine.evalWithArgs("return KEYS[1]", [Buffer.from("second")], []);

  assert.equal((r1 as Buffer).toString(), "first");
  assert.equal((r2 as Buffer).toString(), "second");
});

// =============================================================================
// Module consumption tests
// =============================================================================

test("LuaWasmModule: throws on second create call", async () => {
  await resolveWasmPath();
  const module = await load();
  module.create(createTestHost());

  assert.throws(() => {
    module.create(createTestHost());
  }, /already been used/);
});

test("LuaWasmModule: throws on create after createStandalone", async () => {
  await resolveWasmPath();
  const module = await load();
  module.createStandalone();

  assert.throws(() => {
    module.create(createTestHost());
  }, /already been used/);
});

test("LuaWasmModule: throws on createStandalone after create", async () => {
  await resolveWasmPath();
  const module = await load();
  module.create(createTestHost());

  assert.throws(() => {
    module.createStandalone();
  }, /already been used/);
});

// =============================================================================
// Script error decoration + zero-arg delegation
// =============================================================================

test("redis.call() with no args is delegated to the host", async () => {
  await resolveWasmPath();
  const module = await load();
  let received: Buffer[] | undefined;
  const engine = module.create(
    createTestHost({
      redisCall(args) {
        received = args;
        return { err: Buffer.from("ERR Please specify at least one argument"), code: Buffer.from("ERR") };
      },
    }),
  );

  const result = engine.eval("return redis.call()");
  assert.deepEqual(received, []); // host saw the empty argument list, not a lib short-circuit
  assert.ok(result && typeof result === "object" && "err" in result);
});

test("redis.call command error passes through with code and line/sha metadata", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(
    createTestHost({
      redisCall() {
        return {
          err: Buffer.from("Operation against a key holding the wrong kind of value"),
          code: Buffer.from("WRONGTYPE"),
        };
      },
    }),
  );

  const result = engine.eval("return redis.call('GET', 'k')") as {
    err: Buffer;
    code?: Buffer;
    meta?: { line: number; sha: string; kind?: string };
  };
  assert.ok(result && typeof result === "object" && "err" in result);
  // Command errors already carry their message + code; the engine passes them
  // through undecorated (no kind), attaching only line/sha for the host.
  assert.equal(
    result.err.toString("utf8"),
    "Operation against a key holding the wrong kind of value",
  );
  assert.equal(result.code?.toString("utf8"), "WRONGTYPE");
  assert.equal(result.meta?.line, 1);
  assert.match(result.meta?.sha ?? "", /^[a-f0-9]{40}$/);
  assert.equal(result.meta?.kind, undefined);
});

test("redis.pcall error value returned by the script is not decorated", async () => {
  await resolveWasmPath();
  const module = await load();
  const engine = module.create(
    createTestHost({
      redisCall() {
        return {
          err: Buffer.from("Operation against a key holding the wrong kind of value"),
          code: Buffer.from("WRONGTYPE"),
        };
      },
    }),
  );

  const result = engine.eval("return redis.pcall('GET', 'k')") as { err: Buffer; code?: Buffer };
  assert.ok(result && typeof result === "object" && "err" in result);
  assert.equal(
    result.err.toString("utf8"),
    "Operation against a key holding the wrong kind of value",
  );
  assert.equal(result.code?.toString("utf8"), "WRONGTYPE");
});

// =============================================================================
// redisProps handler (Task 2: host_redis_props wiring)
// =============================================================================

test("redisProps handler: allocates the encoded blob and returns a PtrLen (direct ABI)", () => {
  const heap = new Uint8Array(1024);
  let next = 8;
  const exports = {
    HEAPU8: heap,
    _alloc: (n: number) => {
      const p = next;
      next += n;
      return p;
    },
  } as unknown as WasmExports;

  const blob = encodeRedisProps({ V: { value: "7.4.0" } });
  const handler = makePropsHandler(exports, blob);
  const packed = handler() as bigint;
  const ptr = Number(packed & 0xffffffffn);
  const len = Number(packed >> 32n);
  assert.equal(len, blob.length);
  assert.deepEqual([...heap.subarray(ptr, ptr + len)], [...blob]);
});

test("redisProps handler: returns a zero PtrLen when there are no props", () => {
  const handler = makePropsHandler({} as never, Buffer.alloc(4));
  // count==0 blob is treated as "no props": ptr 0, len 0.
  const packed = handler() as bigint;
  assert.equal(packed, 0n);
});

// =============================================================================
// redisProps integration (Task 3: C decode + apply onto the `redis` table)
// =============================================================================

const noopHost: RedisHost = {
  redisCall: () => null,
  redisPcall: () => null,
  log: () => {},
};

test("redisProps integration: injects constant fields readable from Lua", async () => {
  const engine = await LuaWasmEngine.create({
    host: noopHost,
    redisProps: {
      REDIS_VERSION: { value: "7.4.0" },
      REPL_ALL: { value: 3 },
      FLAG: { value: true },
    },
  });
  assert.deepEqual(engine.eval("return redis.REDIS_VERSION"), Buffer.from("7.4.0"));
  assert.equal(engine.eval("return redis.REPL_ALL"), 3);
  assert.equal(engine.eval("return redis.FLAG"), 1); // true -> 1
});

test("redisProps integration: injects a stub returning a constant", async () => {
  const engine = await LuaWasmEngine.create({
    host: noopHost,
    redisProps: { replicate_commands: { returns: true } },
  });
  assert.equal(engine.eval("return redis.replicate_commands()"), 1);
});

test("redisProps integration: injects a noop stub that returns nothing", async () => {
  const engine = await LuaWasmEngine.create({
    host: noopHost,
    redisProps: { set_repl: { returns: null } },
  });
  assert.equal(engine.eval("return select('#', redis.set_repl(1))"), 0);
});

test("redisProps integration: exposes server as an alias of redis with the same props", async () => {
  const engine = await LuaWasmEngine.create({
    host: noopHost,
    redisProps: { REDIS_VERSION: { value: "7.4.0" } },
  });
  assert.equal(engine.eval("return server == redis"), 1);
  assert.deepEqual(engine.eval("return server.REDIS_VERSION"), Buffer.from("7.4.0"));
});

test("redisProps integration: aliases server even with no props", async () => {
  const engine = await LuaWasmEngine.create({ host: noopHost });
  assert.equal(engine.eval("return server == redis"), 1);
});

test("redisProps integration: makes injected props readonly under globals protection", async () => {
  const engine = await LuaWasmEngine.create({
    host: noopHost,
    redisProps: { REDIS_VERSION: { value: "7.4.0" } },
  });
  const r = engine.eval("redis.REDIS_VERSION = 'x' return 1") as { err: Buffer };
  assert.ok(r && typeof r === "object" && "err" in r);
});
