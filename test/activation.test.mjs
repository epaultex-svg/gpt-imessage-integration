import assert from "node:assert/strict";
import test from "node:test";
import {
  activateChannel,
  parseActivationArguments,
} from "../scripts/lib/activation.mjs";
import { mergeManagedPatch } from "../scripts/lib/patch.mjs";

const SAFE_ENV = {
  PAUL_IMESSAGE_HANDLE: "+14155550101",
  IMSG_CLI_PATH: "/usr/local/bin/imsg",
  IMESSAGE_DB_PATH: "/Users/operator/Library/Messages/chat.db",
  OPENCLAW_CONFIG_PATH: "/Users/operator/.openclaw/openclaw.json",
};

const EXISTING = {
  gateway: { port: 18789, auth: { mode: "token" }, tailscale: { mode: "serve" } },
  channels: {
    slack: { enabled: false },
    imessage: { enabled: false, dmPolicy: "open" },
  },
  agents: { defaults: { workspace: "/Users/operator/workspace" } },
};

function clone(value) {
  return structuredClone(value);
}

function harness({ current = EXISTING, fault, restoreFails = false, preflight = "ready" } = {}) {
  const state = {
    current: clone(current),
    backup: null,
    calls: [],
    writes: 0,
    restores: 0,
    events: [],
    validationCount: 0,
    restartCount: 0,
  };

  const runner = {
    async run(command, args) {
      assert.equal(command, "openclaw");
      state.calls.push([...args]);
      if (args[0] === "config") {
        state.validationCount += 1;
        if (fault === `validation${state.validationCount}`) {
          return { exitCode: 0, stdout: '{"valid":false}', stderr: "private config" };
        }
        if (fault === `malformed${state.validationCount}`) {
          return { exitCode: 0, stdout: "private malformed output", stderr: "" };
        }
        return { exitCode: 0, stdout: '{"valid":true}', stderr: "" };
      }
      if (args[0] === "plugins") {
        state.current.plugins = { entries: { imessage: { enabled: true } } };
        return fault === "plugin"
          ? { exitCode: 1, stdout: "", stderr: "private plugin error" }
          : { exitCode: 0, stdout: "enabled", stderr: "" };
      }
      state.restartCount += 1;
      if (fault === "restart" && state.restartCount === 1) {
        return { exitCode: 1, stdout: "", stderr: "private restart error" };
      }
      if (fault === "recoveryRestart") {
        return { exitCode: 1, stdout: "", stderr: "private recovery error" };
      }
      return { exitCode: 0, stdout: "restarted", stderr: "" };
    },
  };

  return {
    state,
    options: {
      env: SAFE_ENV,
      runner,
      readFileImpl: async () => JSON.stringify(state.current),
      preflightFn: async () => ({ status: preflight }),
      applyPatchFn: async (configPath, patch) => {
        assert.equal(configPath, SAFE_ENV.OPENCLAW_CONFIG_PATH);
        state.writes += 1;
        state.backup = clone(state.current);
        state.events.push("backup");
        state.current = mergeManagedPatch(state.current, patch);
        state.events.push("mutation");
        return { backupPath: "/private/backup/path" };
      },
      restoreBackupFn: async () => {
        state.restores += 1;
        if (restoreFails) throw new Error("private restore failure");
        state.current = clone(state.backup);
      },
    },
  };
}

test("activation argument parser rejects everything except default and --apply", () => {
  assert.deepEqual(parseActivationArguments([]), { valid: true, apply: false });
  assert.deepEqual(parseActivationArguments(["--apply"]), { valid: true, apply: true });
  assert.deepEqual(parseActivationArguments(["--force"]), { valid: false, apply: false });
  assert.deepEqual(parseActivationArguments(["--apply", "extra"]), { valid: false, apply: false });
});

test("dry run validates merge safety with zero commands and writes", async () => {
  const { state, options } = harness();
  const result = await activateChannel(options);
  assert.equal(result.status, "dry_run");
  assert.deepEqual(result.errorCodes, []);
  assert.equal(result.steps.inputs, "valid");
  assert.equal(result.steps.config, "valid");
  assert.deepEqual(state.calls, []);
  assert.equal(state.writes, 0);
});

test("bad environment and unsafe config fail before commands or writes", async () => {
  for (const [env, code] of [
    [{ ...SAFE_ENV, PAUL_IMESSAGE_HANDLE: "" }, "ACTIVATION_ENV_REQUIRED"],
    [{ ...SAFE_ENV, PAUL_IMESSAGE_HANDLE: "*" }, "ACTIVATION_ENV_INVALID"],
    [{ ...SAFE_ENV, OPENCLAW_CONFIG_PATH: "relative.json" }, "ACTIVATION_PATH_INVALID"],
  ]) {
    const { state, options } = harness();
    const result = await activateChannel({ ...options, env });
    assert.deepEqual(result.errorCodes, [code]);
    assert.deepEqual(state.calls, []);
    assert.equal(state.writes, 0);
  }

  const { state, options } = harness();
  const result = await activateChannel({ ...options, readFileImpl: async () => "private not-json" });
  assert.deepEqual(result.errorCodes, ["OPENCLAW_CONFIG_UNSAFE"]);
  assert.deepEqual(state.calls, []);
  assert.equal(state.writes, 0);
});

test("blocked preflight causes zero mutation", async () => {
  const { state, options } = harness({ preflight: "blocked" });
  const result = await activateChannel({ ...options, apply: true });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.errorCodes, ["PREFLIGHT_BLOCKED"]);
  assert.equal(state.writes, 0);
  assert.deepEqual(state.calls, []);
});

test("apply backs up before mutation and uses exact command order", async () => {
  const { state, options } = harness();
  const result = await activateChannel({ ...options, apply: true });
  assert.equal(result.status, "activated");
  assert.deepEqual(state.events, ["backup", "mutation"]);
  assert.deepEqual(state.calls, [
    ["config", "validate", "--json"],
    ["plugins", "enable", "imessage"],
    ["config", "validate", "--json"],
    ["gateway", "restart"],
  ]);
  assert.deepEqual(state.current.agents, EXISTING.agents);
  assert.deepEqual(state.current.channels.slack, EXISTING.channels.slack);
  assert.equal(state.current.gateway.port, 18789);
  assert.deepEqual(state.current.gateway.auth, EXISTING.gateway.auth);
  assert.equal(state.current.gateway.bind, "loopback");
  assert.deepEqual(state.current.gateway.tailscale, { mode: "off" });
  assert.deepEqual(state.current.channels.imessage.allowFrom, [SAFE_ENV.PAUL_IMESSAGE_HANDLE]);
});

test("successful activation is idempotent and preserves unrelated config", async () => {
  const { state, options } = harness();
  assert.equal((await activateChannel({ ...options, apply: true })).status, "activated");
  const once = clone(state.current);
  assert.equal((await activateChannel({ ...options, apply: true })).status, "activated");
  assert.deepEqual(state.current, once);
  assert.equal(state.writes, 2);
  assert.equal(state.calls.length, 8);
});

test("every post-mutation fault point restores exact prior config", async () => {
  for (const [fault, code] of [
    ["validation1", "FIRST_VALIDATION_FAILED"],
    ["malformed1", "FIRST_VALIDATION_FAILED"],
    ["plugin", "PLUGIN_ENABLE_FAILED"],
    ["validation2", "SECOND_VALIDATION_FAILED"],
    ["restart", "GATEWAY_RESTART_FAILED"],
  ]) {
    const { state, options } = harness({ fault });
    const before = clone(state.current);
    const result = await activateChannel({ ...options, apply: true });
    assert.equal(result.status, "rolled_back", fault);
    assert.ok(result.errorCodes.includes(code), fault);
    assert.equal(state.restores, 1, fault);
    assert.deepEqual(state.current, before, fault);
    assert.deepEqual(state.calls.at(-1), ["gateway", "restart"], fault);
  }
});

test("rollback restart or restore failure reports rollback_failed", async () => {
  for (const setup of [
    { fault: "recoveryRestart" },
    { fault: "validation1", restoreFails: true },
  ]) {
    const { state, options } = harness(setup);
    const result = await activateChannel({ ...options, apply: true });
    assert.equal(result.status, "rollback_failed");
    assert.equal(result.steps.rollback, "failed");
    assert.deepEqual(state.calls.at(-1), ["gateway", "restart"]);
  }
});

test("handles, paths, config, and diagnostics never reach result", async () => {
  const { options } = harness({ fault: "plugin" });
  const result = await activateChannel({ ...options, apply: true });
  const output = JSON.stringify(result);
  for (const privateValue of [
    SAFE_ENV.PAUL_IMESSAGE_HANDLE,
    SAFE_ENV.IMSG_CLI_PATH,
    SAFE_ENV.IMESSAGE_DB_PATH,
    SAFE_ENV.OPENCLAW_CONFIG_PATH,
    "private plugin error",
    "workspace",
  ]) {
    assert.equal(output.includes(privateValue), false);
  }
  assert.deepEqual(Object.keys(result), ["status", "errorCodes", "steps"]);
});
