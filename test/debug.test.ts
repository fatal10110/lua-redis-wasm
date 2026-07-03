/**
 * Smoke tests for the debug WASM flavor (load({ debug: true })): breakpoints,
 * variables, paused-frame evaluate, stepping, cancellation, and fuel
 * enforcement under the combined hook.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/index.js";
import type { RedisHost } from "../src/types.js";

type AgentMessage = {
  event: string;
  reason?: string;
  line?: number;
  depth?: number;
  id?: number;
  body?: unknown;
  message?: string;
};

type HostCommand = Record<string, unknown>;

function createTestHost(overrides: Partial<RedisHost> = {}): RedisHost {
  return {
    redisCall(args) {
      const cmd = args[0]?.toString("utf8").toUpperCase();
      if (cmd === "PING") return { ok: Buffer.from("PONG") };
      return { err: Buffer.from("ERR unknown command") };
    },
    redisPcall(args) {
      return this.redisCall(args);
    },
    log() {},
    ...overrides
  };
}

/**
 * Scripted debug session: a queue of steps, each receiving the agent's parsed
 * message and returning the host's reply command. Messages are recorded for
 * post-run assertions.
 */
function scriptedSession(steps: Array<(msg: AgentMessage) => HostCommand>) {
  const seen: AgentMessage[] = [];
  const onDebugRequest = (payload: Buffer): Buffer => {
    const msg = JSON.parse(payload.toString("utf8")) as AgentMessage;
    seen.push(msg);
    const step = steps.shift();
    if (!step) {
      throw new Error(`unexpected agent message: ${payload.toString("utf8")}`);
    }
    return Buffer.from(JSON.stringify(step(msg)), "utf8");
  };
  return { seen, onDebugRequest };
}

const resume = (mode: string, breakpoints: number[] = [], extra: HostCommand = {}): HostCommand => ({
  action: "resume",
  mode,
  breakpoints,
  ...extra
});

const inspect = (id: number, op: string, args: HostCommand = {}): HostCommand => ({
  action: "inspect",
  id,
  op,
  args
});

test("evalDebug: breakpoint, variables, evaluate, resume", async () => {
  const script = [
    "local x = 1",
    'local y = { a = 1, b = "two" }',
    "return x"
  ].join("\n");

  let localsRef = 0;
  const session = scriptedSession([
    msg => {
      assert.equal(msg.event, "ready");
      return resume("continue", [3]);
    },
    msg => {
      assert.equal(msg.event, "stopped");
      assert.equal(msg.reason, "breakpoint");
      assert.equal(msg.line, 3);
      return inspect(1, "scopes", { frame: 0 });
    },
    msg => {
      assert.equal(msg.event, "result");
      const scopes = msg.body as Array<{ name: string; ref: number }>;
      const locals = scopes.find(scope => scope.name === "Locals");
      assert.ok(locals && locals.ref > 0, "Locals scope with a handle");
      localsRef = locals.ref;
      return inspect(2, "variables", { ref: localsRef });
    },
    msg => {
      assert.equal(msg.event, "result");
      const vars = msg.body as Array<{ name: string; value: string; type: string; ref: number }>;
      const x = vars.find(v => v.name === "x");
      assert.ok(x, "local x visible");
      assert.equal(x.value, "1");
      assert.equal(x.type, "number");
      const y = vars.find(v => v.name === "y");
      assert.ok(y && y.ref > 0, "local table y expandable");
      return inspect(3, "evaluate", { frame: 0, expression: "x + 41" });
    },
    msg => {
      assert.equal(msg.event, "result");
      const result = msg.body as { value: string; type: string };
      assert.equal(result.value, "42");
      assert.equal(result.type, "number");
      return resume("continue");
    }
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  const reply = await engine.evalDebug(script);
  assert.equal(reply, 1);
});

test("evalDebug: stopOnEntry then stepOver walks lines", async () => {
  const script = ["local a = 1", "local b = 2", "return a + b"].join("\n");
  const stops: Array<{ reason?: string; line?: number }> = [];

  const session = scriptedSession([
    msg => {
      assert.equal(msg.event, "ready");
      return resume("continue", [], { stopOnEntry: true });
    },
    msg => {
      stops.push({ reason: msg.reason, line: msg.line });
      return resume("stepOver");
    },
    msg => {
      stops.push({ reason: msg.reason, line: msg.line });
      return resume("stepOver");
    },
    msg => {
      stops.push({ reason: msg.reason, line: msg.line });
      return resume("continue");
    }
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  const reply = await engine.evalDebug(script);
  assert.equal(reply, 3);
  assert.deepEqual(stops, [
    { reason: "entry", line: 1 },
    { reason: "step", line: 2 },
    { reason: "step", line: 3 }
  ]);
});

test("evalDebug: redis.call still reaches the host while debugging", async () => {
  const script = 'return redis.call("PING")';
  const session = scriptedSession([
    () => resume("continue")
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  const reply = await engine.evalDebug(script);
  assert.deepEqual(reply, { ok: Buffer.from("PONG") });
});

test("evalDebug: paused evaluate can call redis.call against the live host", async () => {
  const script = ["local x = 1", "return x"].join("\n");
  const session = scriptedSession([
    () => resume("continue", [2]),
    msg => {
      assert.equal(msg.event, "stopped");
      return inspect(1, "evaluate", { frame: 0, expression: 'redis.call("PING").ok' });
    },
    msg => {
      assert.equal(msg.event, "result");
      assert.equal((msg.body as { value: string }).value, '"PONG"');
      return resume("continue");
    }
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  assert.equal(await engine.evalDebug(script), 1);
});

test("evalDebug: cancel aborts the paused script", async () => {
  const script = ["local x = 1", "return x"].join("\n");
  const session = scriptedSession([
    () => resume("continue", [2]),
    msg => {
      assert.equal(msg.event, "stopped");
      return { action: "cancel", reason: "debugger detached" };
    }
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  const reply = await engine.evalDebug(script);
  assert.ok(reply && typeof reply === "object" && "err" in reply, "error reply");
  const err = (reply as { err: Buffer }).err.toString("utf8");
  assert.match(err, /__RLUA_DEBUG_CANCEL__/);
  assert.match(err, /debugger detached/);
});

test("evalDebug: combined hook still enforces the fuel limit", async () => {
  const session = scriptedSession([
    () => resume("continue")
  ]);

  const module = await load({ debug: true, limits: { maxFuel: 100_000 } });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  const reply = await engine.evalDebug("while true do end");
  assert.ok(reply && typeof reply === "object" && "err" in reply, "error reply");
  assert.match((reply as { err: Buffer }).err.toString("utf8"), /fuel limit/);
});

test("evalDebug: a later non-debug eval on the same engine is unaffected", async () => {
  const session = scriptedSession([
    () => resume("continue")
  ]);

  const module = await load({ debug: true });
  const engine = module.create(createTestHost({ onDebugRequest: session.onDebugRequest }));
  assert.equal(await engine.evalDebug("return 1"), 1);
  // Line hook removed, agent torn down: the sync path must work as usual.
  assert.equal(engine.evalWithArgs("return 2"), 2);
});

test("evalDebug: default flavor rejects with a clear error", async () => {
  const module = await load();
  const engine = module.create(createTestHost());
  await assert.rejects(
    () => engine.evalDebug("return 1"),
    /debug WASM flavor/
  );
});

test("evalDebug: debug flavor without onDebugRequest fails cleanly", async () => {
  const module = await load({ debug: true });
  const engine = module.create(createTestHost());
  const reply = await engine.evalDebug("return 1");
  assert.ok(reply && typeof reply === "object" && "err" in reply, "error reply");
  assert.match((reply as { err: Buffer }).err.toString("utf8"), /no debug session attached/);
});
