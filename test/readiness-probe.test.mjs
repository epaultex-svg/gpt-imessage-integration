import assert from "node:assert/strict";
import test from "node:test";
import { buildConfig } from "../scripts/lib/config.mjs";
import {
  probeArgumentsValid,
  runReadinessProbe,
} from "../scripts/lib/readiness-probe.mjs";

const CONFIG_PATH = "/Users/private/.openclaw/openclaw.json";
const PRIVATE_HANDLE = "+14155550101";
const MANAGED = buildConfig({
  PAUL_IMESSAGE_HANDLE: PRIVATE_HANDLE,
  IMSG_CLI_PATH: "/usr/local/bin/imsg",
  IMESSAGE_DB_PATH: "/Users/private/Library/Messages/chat.db",
});
const FULL_CONFIG = {
  ...MANAGED,
  agents: { defaults: { workspace: "/Users/private/workspace" } },
  gateway: { ...MANAGED.gateway, port: 18789 },
  channels: { ...MANAGED.channels, slack: { enabled: false } },
};

const COMMANDS = [
  ["config", "validate", "--json"],
  ["plugins", "inspect", "imessage", "--json"],
  ["gateway", "health", "--json"],
  ["channels", "status", "--channel", "imessage", "--probe", "--json"],
];

const HEALTHY = {
  config: { valid: true, diagnostics: [] },
  plugin: {
    workspaceDir: "/Users/private/workspace",
    plugin: {
      id: "imessage",
      origin: "bundled",
      enabled: true,
      activated: true,
      status: "loaded",
      channelIds: ["imessage"],
    },
  },
  gateway: { ok: true, plugins: { loaded: ["imessage"] } },
  channel: {
    channels: {
      imessage: {
        configured: true,
        running: true,
        lastError: null,
        probe: { ok: true },
      },
    },
    channelAccounts: {
      imessage: [
        {
          id: "PRIVATE-ACCOUNT-ID",
          enabled: true,
          configured: true,
          running: true,
          probe: { ok: true, timestamp: "PRIVATE-TIMESTAMP" },
        },
      ],
    },
  },
};

const INDEX_TO_CHECK = ["config", "plugin", "gateway", "channel"];

function response(value) {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fakeRunner(overrides = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const index = COMMANDS.findIndex((expected) => expected.join("\0") === args.join("\0"));
      const check = INDEX_TO_CHECK[index];
      const override = overrides[check];
      if (override instanceof Error) throw override;
      return override ?? response(HEALTHY[check]);
    },
  };
}

async function probe({ runner = fakeRunner(), config = FULL_CONFIG, env, readFileImpl } = {}) {
  return runReadinessProbe({
    env: env ?? { OPENCLAW_CONFIG_PATH: CONFIG_PATH },
    runner,
    readFileImpl: readFileImpl ?? (async () => JSON.stringify(config)),
  });
}

test("probe accepts no CLI arguments", () => {
  assert.equal(probeArgumentsValid([]), true);
  assert.equal(probeArgumentsValid(["--verbose"]), false);
});

test("healthy readiness uses exact sequential argv and fixed output", async () => {
  const runner = fakeRunner();
  const result = await probe({ runner });
  assert.deepEqual(result, {
    status: "ready",
    checks: {
      policy: { status: "pass" },
      config: { status: "pass" },
      plugin: { status: "pass" },
      gateway: { status: "pass" },
      channel: { status: "pass" },
    },
    errorCodes: [],
  });
  assert.deepEqual(runner.calls, COMMANDS.map((args) => ({ command: "openclaw", args })));
});

test("absolute path and safe extracted managed policy gate all commands", async () => {
  for (const [options, code] of [
    [{ env: {} }, "OPENCLAW_CONFIG_PATH_REQUIRED"],
    [{ env: { OPENCLAW_CONFIG_PATH: "relative.json" } }, "OPENCLAW_CONFIG_PATH_INVALID"],
    [{ readFileImpl: async () => "private malformed config" }, "MANAGED_POLICY_INVALID"],
    [
      {
        config: {
          ...FULL_CONFIG,
          gateway: { ...FULL_CONFIG.gateway, tailscale: { mode: "serve" } },
        },
      },
      "MANAGED_POLICY_INVALID",
    ],
  ]) {
    const runner = fakeRunner();
    const result = await probe({ ...options, runner });
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(result.checks.policy.status, "fail");
    assert.deepEqual(runner.calls, []);
  }
});

test("each command classifies nonzero, malformed, timeout, and unhealthy output", async () => {
  const unhealthy = {
    config: response({ valid: false }),
    plugin: response({
      ...HEALTHY.plugin,
      plugin: { ...HEALTHY.plugin.plugin, activated: false },
    }),
    gateway: response({ ...HEALTHY.gateway, ok: false }),
    channel: response({
      ...HEALTHY.channel,
      channels: { imessage: { ...HEALTHY.channel.channels.imessage, running: false } },
    }),
  };
  const unhealthyCodes = {
    config: "OPENCLAW_CONFIG_INVALID",
    plugin: "IMESSAGE_PLUGIN_NOT_READY",
    gateway: "GATEWAY_NOT_READY",
    channel: "IMESSAGE_CHANNEL_NOT_READY",
  };

  for (const check of INDEX_TO_CHECK) {
    for (const [commandResult, code] of [
      [{ exitCode: 1, stdout: "", stderr: "private diagnostic" }, `${check.toUpperCase()}_PROBE_FAILED`],
      [{ exitCode: 0, stdout: "private not-json", stderr: "" }, `${check.toUpperCase()}_PROBE_MALFORMED`],
      [{ exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }, `${check.toUpperCase()}_PROBE_TIMEOUT`],
      [unhealthy[check], unhealthyCodes[check]],
    ]) {
      const result = await probe({ runner: fakeRunner({ [check]: commandResult }) });
      assert.equal(result.status, "blocked", `${check}:${code}`);
      assert.equal(result.checks[check].status, "fail", `${check}:${code}`);
      assert.ok(result.errorCodes.includes(code), `${check}:${code}`);
    }
  }
});

test("plugin readiness requires every bundled activation field", async () => {
  for (const patch of [
    { id: "other" },
    { origin: "external" },
    { enabled: false },
    { activated: false },
    { status: "disabled" },
    { channelIds: [] },
  ]) {
    const result = await probe({
      runner: fakeRunner({
        plugin: response({
          ...HEALTHY.plugin,
          plugin: { ...HEALTHY.plugin.plugin, ...patch },
        }),
      }),
    });
    assert.ok(result.errorCodes.includes("IMESSAGE_PLUGIN_NOT_READY"));
  }
});

test("missing or malformed nested plugin object is malformed", async () => {
  for (const payload of [{}, { workspaceDir: "/private", plugin: null }, { plugin: [] }]) {
    const result = await probe({ runner: fakeRunner({ plugin: response(payload) }) });
    assert.ok(result.errorCodes.includes("PLUGIN_PROBE_MALFORMED"));
  }
});

test("gateway and channel reject config-only or incomplete runtime state", async () => {
  const channelCases = [
    { ...HEALTHY.channel, configOnly: true },
    {
      ...HEALTHY.channel,
      channels: { imessage: { ...HEALTHY.channel.channels.imessage, lastError: "private error" } },
    },
    { ...HEALTHY.channel, channelAccounts: { imessage: [] } },
    {
      ...HEALTHY.channel,
      channelAccounts: {
        imessage: [
          HEALTHY.channel.channelAccounts.imessage[0],
          { ...HEALTHY.channel.channelAccounts.imessage[0], id: "PRIVATE-SECOND-ID" },
        ],
      },
    },
    {
      ...HEALTHY.channel,
      channelAccounts: {
        imessage: [{ ...HEALTHY.channel.channelAccounts.imessage[0], running: false }],
      },
    },
  ];
  for (const channel of channelCases) {
    const result = await probe({ runner: fakeRunner({ channel: response(channel) }) });
    assert.ok(result.errorCodes.includes("IMESSAGE_CHANNEL_NOT_READY"));
  }

  const gateway = await probe({
    runner: fakeRunner({ gateway: response({ ok: true, plugins: { loaded: [] } }) }),
  });
  assert.ok(gateway.errorCodes.includes("GATEWAY_NOT_READY"));
});

test("thrown runner failures remain fixed and later probes continue sequentially", async () => {
  const runner = fakeRunner({
    config: new Error("private config exception"),
    plugin: new Error("private plugin exception"),
    gateway: new Error("private gateway exception"),
    channel: new Error("private channel exception"),
  });
  const result = await probe({ runner });
  assert.deepEqual(result.errorCodes, [
    "CONFIG_PROBE_FAILED",
    "PLUGIN_PROBE_FAILED",
    "GATEWAY_PROBE_FAILED",
    "CHANNEL_PROBE_FAILED",
  ]);
  assert.deepEqual(runner.calls, COMMANDS.map((args) => ({ command: "openclaw", args })));
});

test("probe never emits paths, handles, diagnostics, timestamps, or account IDs", async () => {
  const privateDiagnostic = `failed ${CONFIG_PATH} ${PRIVATE_HANDLE} PRIVATE-ACCOUNT-ID PRIVATE-TIMESTAMP`;
  const result = await probe({
    runner: fakeRunner({
      gateway: { exitCode: 1, stdout: privateDiagnostic, stderr: privateDiagnostic },
    }),
  });
  const output = JSON.stringify(result);
  for (const value of [
    CONFIG_PATH,
    PRIVATE_HANDLE,
    "/Users/private/Library/Messages/chat.db",
    privateDiagnostic,
    "PRIVATE-ACCOUNT-ID",
    "PRIVATE-TIMESTAMP",
  ]) {
    assert.equal(output.includes(value), false);
  }
  assert.deepEqual(Object.keys(result), ["status", "checks", "errorCodes"]);
});
