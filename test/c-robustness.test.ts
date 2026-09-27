/**
 * Robustness of the C side of the module:
 * - cjson running out of memory raises Lua's "not enough memory" instead of
 *   aborting the module, without leaking its buffers (#74);
 * - nested C calls hit Lua's "C stack overflow" error instead of overflowing
 *   the WASM C stack (#77).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { load } from "../src/index.js";
import type { ReplyValue } from "../src/types.js";

const TIMEOUT = { timeout: 60_000 };

async function standalone() {
  return (await load()).createStandalone();
}

type Engine = Awaited<ReturnType<typeof standalone>>;

function assertErr(value: ReplyValue, message: RegExp): void {
  assert.ok(value && typeof value === "object" && "err" in value, `expected an error reply, got ${String(value)}`);
  assert.match((value as { err: Buffer }).err.toString("utf8"), message);
}

function assertUsable(engine: Engine): void {
  assert.equal(engine.eval("return 1 + 1"), 2);
  assert.deepEqual(engine.eval("return cjson.encode({1, 'a', {b = true}})"), Buffer.from('[1,"a",{"b":true}]'));
  assert.equal(engine.eval("return cjson.decode('[1,[2,[3]]]')[2][2][1]"), 3);
}

/** Needs about 12 MB of contiguous heap (string.rep builds the result in pieces). */
function assertLargeAllocationSucceeds(engine: Engine): void {
  assert.equal(engine.eval("return #string.rep('y', 12 * 1024 * 1024)"), 12 * 1024 * 1024);
}

// =============================================================================
// cjson out of memory (#74)
// =============================================================================

/** A 22-level table of shared subtables: small in Lua, ~20 MB as JSON. */
const HUGE_ENCODE = "local t = {} for i = 1, 22 do t = {t, t} end return #cjson.encode(t)";

test("cjson: encoding a document too large for the heap raises 'not enough memory'", TIMEOUT, async () => {
  const engine = await standalone();
  for (let round = 0; round < 10; round++) {
    assertErr(engine.eval(HUGE_ENCODE), /^not enough memory$/);
    assertUsable(engine);
  }
  // Neither the failed encodes nor the buffer cjson keeps between calls hold
  // on to the memory.
  assertLargeAllocationSucceeds(engine);
});

test("cjson: the memory error can be caught, and cjson keeps working", TIMEOUT, async () => {
  const engine = await standalone();
  const reply = engine.eval(`
    local t = {} for i = 1, 22 do t = {t, t} end
    local ok, err = pcall(cjson.encode, t)
    return {tostring(ok), err, cjson.encode({1, 2, {x = 'y'}})}
  `);
  assert.deepEqual(reply, [Buffer.from("false"), Buffer.from("not enough memory"), Buffer.from('[1,2,{"x":"y"}]')]);

  // Raised on the coroutine running cjson: resume reports it.
  const inCoroutine = engine.eval(`
    local t = {} for i = 1, 22 do t = {t, t} end
    local co = coroutine.create(function() return cjson.encode(t) end)
    local ok, err = coroutine.resume(co)
    return {tostring(ok), err, coroutine.status(co), cjson.encode({true})}
  `);
  assert.deepEqual(inCoroutine, [
    Buffer.from("false"),
    Buffer.from("not enough memory"),
    Buffer.from("dead"),
    Buffer.from("[true]"),
  ]);
  assertUsable(engine);
  assertLargeAllocationSucceeds(engine);
});

test("cjson: a failed encode with encode_keep_buffer off does not leak its buffer", TIMEOUT, async () => {
  const engine = await standalone();
  // The setting lives in the cjson config and so persists across scripts.
  engine.eval("cjson.encode_keep_buffer(false)");
  for (let round = 0; round < 5; round++) {
    assertErr(engine.eval(HUGE_ENCODE), /^not enough memory$/);
  }
  assertUsable(engine);
  assertLargeAllocationSucceeds(engine);
});

test("cjson: a decode that runs out of memory does not leak its scratch buffer", TIMEOUT, async () => {
  const engine = await standalone();
  // A 4.4 MB document (the size of decode's scratch buffer) whose 2 million
  // tables do not fit the heap.
  const script = "local s = '[' .. string.rep('[[[[[]]]]],', 4e5) .. '[]]' return #cjson.decode(s)";
  for (let round = 0; round < 5; round++) {
    assertErr(engine.eval(script), /^not enough memory$/);
  }
  assertUsable(engine);
  assertLargeAllocationSucceeds(engine);
});

test("cjson: encoding output is unchanged", TIMEOUT, async () => {
  const engine = await standalone();
  const encode = (script: string) => engine.eval(script) as Buffer;
  const sha1 = (buf: Buffer) => createHash("sha1").update(buf).digest("hex");

  assert.equal(encode("return cjson.encode({1, 2, 3, {a = 1}})").toString(), '[1,2,3,{"a":1}]');
  assert.equal(
    encode("return cjson.encode({a = 'x\"y\\\\z/\\n\\r\\t\\0\\1', b = {true, false, cjson.null}})").toString(),
    '{"a":"x\\"y\\\\z\\/\\n\\r\\t\\u0000\\u0001","b":[true,false,null]}',
  );
  assert.equal(
    encode("return cjson.encode({0.1, 1e300, 1/3, 123456789012345, -1.5e-7})").toString(),
    "[0.1,1e+300,0.33333333333333,1.2345678901234e+14,-1.5e-07]",
  );
  // Output that grows the buffer many times.
  assert.deepEqual(
    encode("return cjson.encode(string.rep('abc\\n', 50000))"),
    Buffer.from(`"${"abc\\n".repeat(50000)}"`),
  );
  const objects = encode("local t = {} for i = 1, 20000 do t[i] = {id = i, s = 'v' .. i} end return cjson.encode(t)");
  assert.equal(objects.length, 497789);
  assert.equal(sha1(objects), "6f969aa935dfb24044b3b16852f63a880d0089de");
  const shared = encode("local t = {} for i = 1, 16 do t = {t, t} end return cjson.encode(t)");
  assert.equal(shared.length, 327677);
  assert.equal(sha1(shared), "1ecb2be0ac18de41d4f7581772b9c2b3cad0ada8");

  // The kept buffer (the default) and a private one give the same output,
  // also for a buffer reused across calls and scripts.
  const sameBothWays = `
    local v = {x = string.rep('q', 70000), y = {1, 2}}
    local kept1, kept2 = cjson.encode(v), cjson.encode({1})
    cjson.encode_keep_buffer(false)
    local private1, private2 = cjson.encode(v), cjson.encode({1})
    cjson.encode_keep_buffer(true)
    return {tostring(kept1 == private1), kept2, private2, #kept1}
  `;
  for (let round = 0; round < 2; round++) {
    assert.deepEqual(engine.eval(sameBothWays), [Buffer.from("true"), Buffer.from("[1]"), Buffer.from("[1]"), 70018]);
  }
  assert.deepEqual(
    engine.eval(`return cjson.encode(cjson.decode('{"k":[1,2,{"n":null}]}'))`),
    Buffer.from('{"k":[1,2,{"n":null}]}'),
  );
});

// =============================================================================
// Nested C calls and the C stack (#77)
// =============================================================================

/** Nests `depth` string.gsub callbacks, each one a nested C call. */
function nestedGsub(depth: number, bottom = "return 'bottom'"): string {
  return `
    local function f(n)
      if n == 0 then ${bottom} end
      return (string.gsub('x', 'x', function() return f(n - 1) end))
    end
    return f(${depth})`;
}

test("C stack: nested string.gsub callbacks up to Lua's limit run", TIMEOUT, async () => {
  const engine = await standalone();
  for (const depth of [60, 70, 100, 150, 198]) {
    assert.deepEqual(engine.eval(nestedGsub(depth)), Buffer.from("bottom"), `depth ${depth}`);
  }
  assertUsable(engine);
});

test("C stack: nesting past Lua's limit raises 'C stack overflow'", TIMEOUT, async () => {
  const engine = await standalone();
  for (const depth of [200, 1000]) {
    assertErr(engine.eval(nestedGsub(depth)), /stack overflow/);
    assertUsable(engine);
  }
  // Caught inside the script like any other error.
  const caught = engine.eval(`
    local function f(n) return (string.gsub('x', 'x', function() return f(n + 1) end)) end
    local ok, err = pcall(f, 0)
    return {tostring(ok), err}
  `);
  assert.deepEqual(caught, [Buffer.from("false"), Buffer.from("C stack overflow")]);
  assertUsable(engine);
});

test("C stack: an xpcall handler that raises again terminates", TIMEOUT, async () => {
  const engine = await standalone();
  const bottom = "return xpcall(function() error('x') end, function(e) error(e) end)";
  // xpcall returns false (error in error handling); gsub keeps the match.
  for (const depth of [0, 30, 100]) {
    assert.deepEqual(engine.eval(nestedGsub(depth, bottom)), depth === 0 ? null : Buffer.from("x"), `depth ${depth}`);
  }
  assertErr(engine.eval(nestedGsub(199, bottom)), /stack overflow/);
  assertUsable(engine);
});

test("C stack: other deep nesting that fits Lua's limits keeps working", TIMEOUT, async () => {
  const engine = await standalone();
  // cjson.decode at its default depth limit (1000); it overflowed from ~700.
  assert.equal(engine.eval("return #cjson.decode(string.rep('[', 1000) .. string.rep(']', 1000))"), 1);
  assertErr(engine.eval("return cjson.decode(string.rep('[', 1001) .. string.rep(']', 1001))"), /too many nested/);
  // Plain Lua recursion does not nest C calls.
  assert.equal(engine.eval("local function f(n) if n == 0 then return 0 end return 1 + f(n - 1) end return f(15000)"), 15000);
  const nested: Record<string, string> = {
    pcall: "local function f(n) if n == 0 then return 'bottom' end local ok, r = pcall(f, n - 1) return r end return f(190)",
    coroutine:
      "local function f(n) if n == 0 then return 'bottom' end local ok, r = coroutine.resume(coroutine.create(f), n - 1) return r end return f(190)",
    sort: "local function f(n) if n == 0 then return 'bottom' end local r table.sort({3, 1, 2}, function(a, b) r = r or f(n - 1) return a < b end) return r end return f(190)",
    tostring:
      "local mt = {} mt.__tostring = function(t) if t.n == 0 then return 'bottom' end return tostring(setmetatable({n = t.n - 1}, mt)) end return tostring(setmetatable({n = 190}, mt))",
  };
  for (const [name, script] of Object.entries(nested)) {
    assert.deepEqual(engine.eval(script), Buffer.from("bottom"), name);
  }
  assertUsable(engine);
});
