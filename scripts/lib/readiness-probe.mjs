import { readFile } from "node:fs/promises";
import path from "node:path";
import { validateConfig } from "./config.mjs";
import { createCommandRunner } from "./preflight.mjs";

const CHECK_NAMES = ["policy", "config", "plugin", "gateway", "channel"];

function makeResult() {
  return {
    status: "blocked",
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, { status: "fail" }])),
    errorCodes: [],
  };
}

function pass(result, check) {
  result.checks[check] = { status: "pass" };
}

function fail(result, check, code) {
  result.checks[check] = { status: "fail" };
  if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isTimeout(commandResult) {
  return commandResult?.errorCode === "ETIMEDOUT" || commandResult?.timedOut === true;
}

function pluginReady(value) {
  const plugin = value.plugin;
  return plugin.id === "imessage" &&
    plugin.origin === "bundled" &&
    plugin.enabled === true &&
    plugin.activated === true &&
    plugin.status === "loaded" &&
    Array.isArray(plugin.channelIds) &&
    plugin.channelIds.includes("imessage");
}

function gatewayReady(value) {
  return value.ok === true &&
    value.plugins &&
    typeof value.plugins === "object" &&
    Array.isArray(value.plugins.loaded) &&
    value.plugins.loaded.includes("imessage");
}

function channelReady(value) {
  const channel = value.channels?.imessage;
  const accounts = value.channelAccounts?.imessage;
  if (
    value.configOnly === true ||
    value.status === "config-only" ||
    !channel ||
    typeof channel !== "object" ||
    channel.configOnly === true ||
    channel.status === "config-only" ||
    channel.configured !== true ||
    channel.running !== true ||
    (channel.lastError !== undefined && channel.lastError !== null) ||
    channel.probe?.ok !== true ||
    !Array.isArray(accounts) ||
    accounts.length !== 1
  ) {
    return false;
  }
  const account = accounts[0];
  return account &&
    typeof account === "object" &&
    account.enabled === true &&
    account.configured === true &&
    account.running === true &&
    account.probe?.ok === true;
}

const COMMANDS = [
  {
    check: "config",
    args: ["config", "validate", "--json"],
    unhealthyCode: "OPENCLAW_CONFIG_INVALID",
    ready: (value) => value.valid === true,
  },
  {
    check: "plugin",
    args: ["plugins", "inspect", "imessage", "--json"],
    unhealthyCode: "IMESSAGE_PLUGIN_NOT_READY",
    validShape: (value) => value.plugin && typeof value.plugin === "object" && !Array.isArray(value.plugin),
    ready: pluginReady,
  },
  {
    check: "gateway",
    args: ["gateway", "health", "--json"],
    unhealthyCode: "GATEWAY_NOT_READY",
    ready: gatewayReady,
  },
  {
    check: "channel",
    args: ["channels", "status", "--channel", "imessage", "--probe", "--json"],
    unhealthyCode: "IMESSAGE_CHANNEL_NOT_READY",
    ready: channelReady,
  },
];

export async function runReadinessProbe({
  env = process.env,
  runner = createCommandRunner({ timeoutMs: 35_000 }),
  readFileImpl = readFile,
} = {}) {
  const result = makeResult();
  const configPath = env.OPENCLAW_CONFIG_PATH;
  if (typeof configPath !== "string" || configPath.length === 0) {
    fail(result, "policy", "OPENCLAW_CONFIG_PATH_REQUIRED");
    return result;
  }
  if (configPath !== configPath.trim() || !path.isAbsolute(configPath)) {
    fail(result, "policy", "OPENCLAW_CONFIG_PATH_INVALID");
    return result;
  }

  try {
    const fullConfig = JSON.parse(await readFileImpl(configPath, "utf8"));
    const managedConfig = {
      gateway: {
        mode: fullConfig?.gateway?.mode,
        bind: fullConfig?.gateway?.bind,
        tailscale: structuredClone(fullConfig?.gateway?.tailscale),
      },
      channels: {
        imessage: structuredClone(fullConfig?.channels?.imessage),
      },
    };
    if (validateConfig(managedConfig).length !== 0) throw new Error();
  } catch {
    fail(result, "policy", "MANAGED_POLICY_INVALID");
    return result;
  }
  pass(result, "policy");

  for (const probe of COMMANDS) {
    let commandResult;
    try {
      commandResult = await runner.run("openclaw", probe.args);
    } catch {
      commandResult = null;
    }
    const prefix = probe.check.toUpperCase();
    if (isTimeout(commandResult)) {
      fail(result, probe.check, `${prefix}_PROBE_TIMEOUT`);
      continue;
    }
    if (!commandResult || commandResult.exitCode !== 0) {
      fail(result, probe.check, `${prefix}_PROBE_FAILED`);
      continue;
    }
    const parsed = parseObject(commandResult.stdout);
    if (!parsed) {
      fail(result, probe.check, `${prefix}_PROBE_MALFORMED`);
      continue;
    }
    if (probe.validShape && !probe.validShape(parsed)) {
      fail(result, probe.check, `${prefix}_PROBE_MALFORMED`);
      continue;
    }
    if (!probe.ready(parsed)) {
      fail(result, probe.check, probe.unhealthyCode);
      continue;
    }
    pass(result, probe.check);
  }

  if (Object.values(result.checks).every((check) => check.status === "pass")) {
    result.status = "ready";
  }
  return result;
}

export function probeArgumentsValid(args) {
  return args.length === 0;
}

export function invalidArgumentsResult() {
  const result = makeResult();
  fail(result, "policy", "ARGUMENTS_INVALID");
  return result;
}
