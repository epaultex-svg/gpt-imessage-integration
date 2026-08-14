import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildConfig } from "./config.mjs";
import { applyManagedPatch, mergeManagedPatch, restoreManagedBackup } from "./patch.mjs";
import { createCommandRunner, runPreflight } from "./preflight.mjs";

const STEP_NAMES = [
  "inputs",
  "config",
  "preflight",
  "mutation",
  "firstValidation",
  "pluginEnable",
  "secondValidation",
  "gatewayRestart",
  "rollback",
];

function makeResult() {
  return {
    status: "blocked",
    errorCodes: [],
    steps: Object.fromEntries(STEP_NAMES.map((step) => [step, "not_run"])),
  };
}

function fail(result, code) {
  if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
  return result;
}

function parseValidation(commandResult) {
  if (!commandResult || commandResult.exitCode !== 0) return false;
  try {
    const parsed = JSON.parse(commandResult.stdout);
    return parsed && typeof parsed === "object" && parsed.valid === true;
  } catch {
    return false;
  }
}

async function command(runner, args) {
  try {
    return await runner.run("openclaw", args);
  } catch {
    return null;
  }
}

async function rollback(result, runner, configPath, backupPath, restoreBackupFn, faultCode) {
  fail(result, faultCode);
  result.steps.rollback = "attempted";
  let restored = false;
  let restarted = false;
  try {
    await restoreBackupFn(configPath, backupPath);
    restored = true;
  } catch {
    fail(result, "ROLLBACK_RESTORE_FAILED");
  }
  const restartResult = await command(runner, ["gateway", "restart"]);
  if (restartResult?.exitCode === 0) restarted = true;
  else fail(result, "ROLLBACK_RESTART_FAILED");

  if (restored && restarted) {
    result.status = "rolled_back";
    result.steps.rollback = "complete";
  } else {
    result.status = "rollback_failed";
    result.steps.rollback = "failed";
  }
  return result;
}

export async function activateChannel({
  apply = false,
  env = process.env,
  runner = createCommandRunner(),
  preflightFn = ({ runner: commandRunner }) => runPreflight({ runner: commandRunner }),
  readFileImpl = readFile,
  applyPatchFn = applyManagedPatch,
  restoreBackupFn = restoreManagedBackup,
} = {}) {
  const result = makeResult();
  const required = [
    "PAUL_IMESSAGE_HANDLE",
    "IMSG_CLI_PATH",
    "IMESSAGE_DB_PATH",
    "OPENCLAW_CONFIG_PATH",
  ];
  if (required.some((key) => typeof env[key] !== "string" || env[key].length === 0)) {
    return fail(result, "ACTIVATION_ENV_REQUIRED");
  }
  if (required.some((key) => env[key] !== env[key].trim())) {
    return fail(result, "ACTIVATION_ENV_INVALID");
  }
  if (
    !path.isAbsolute(env.IMSG_CLI_PATH) ||
    !path.isAbsolute(env.IMESSAGE_DB_PATH) ||
    !path.isAbsolute(env.OPENCLAW_CONFIG_PATH)
  ) {
    return fail(result, "ACTIVATION_PATH_INVALID");
  }

  let patch;
  try {
    patch = buildConfig({
      PAUL_IMESSAGE_HANDLE: env.PAUL_IMESSAGE_HANDLE,
      IMSG_CLI_PATH: env.IMSG_CLI_PATH,
      IMESSAGE_DB_PATH: env.IMESSAGE_DB_PATH,
    });
  } catch {
    return fail(result, "ACTIVATION_ENV_INVALID");
  }
  result.steps.inputs = "valid";

  try {
    const raw = await readFileImpl(env.OPENCLAW_CONFIG_PATH, "utf8");
    const existing = JSON.parse(raw);
    mergeManagedPatch(existing, patch);
  } catch {
    result.steps.config = "failed";
    return fail(result, "OPENCLAW_CONFIG_UNSAFE");
  }
  result.steps.config = "valid";

  if (!apply) {
    result.status = "dry_run";
    return result;
  }

  let preflight;
  try {
    preflight = await preflightFn({ runner });
  } catch {
    preflight = null;
  }
  if (preflight?.status !== "ready") {
    result.steps.preflight = "blocked";
    return fail(result, "PREFLIGHT_BLOCKED");
  }
  result.steps.preflight = "passed";

  let applied;
  try {
    applied = await applyPatchFn(env.OPENCLAW_CONFIG_PATH, patch);
  } catch {
    result.steps.mutation = "failed";
    return fail(result, "CONFIG_MUTATION_FAILED");
  }
  result.steps.mutation = "applied";

  const firstValidation = await command(runner, ["config", "validate", "--json"]);
  if (!parseValidation(firstValidation)) {
    result.steps.firstValidation = "failed";
    return rollback(
      result,
      runner,
      env.OPENCLAW_CONFIG_PATH,
      applied.backupPath,
      restoreBackupFn,
      "FIRST_VALIDATION_FAILED",
    );
  }
  result.steps.firstValidation = "passed";

  const pluginEnable = await command(runner, ["plugins", "enable", "imessage"]);
  if (pluginEnable?.exitCode !== 0) {
    result.steps.pluginEnable = "failed";
    return rollback(
      result,
      runner,
      env.OPENCLAW_CONFIG_PATH,
      applied.backupPath,
      restoreBackupFn,
      "PLUGIN_ENABLE_FAILED",
    );
  }
  result.steps.pluginEnable = "passed";

  const secondValidation = await command(runner, ["config", "validate", "--json"]);
  if (!parseValidation(secondValidation)) {
    result.steps.secondValidation = "failed";
    return rollback(
      result,
      runner,
      env.OPENCLAW_CONFIG_PATH,
      applied.backupPath,
      restoreBackupFn,
      "SECOND_VALIDATION_FAILED",
    );
  }
  result.steps.secondValidation = "passed";

  const restart = await command(runner, ["gateway", "restart"]);
  if (restart?.exitCode !== 0) {
    result.steps.gatewayRestart = "failed";
    return rollback(
      result,
      runner,
      env.OPENCLAW_CONFIG_PATH,
      applied.backupPath,
      restoreBackupFn,
      "GATEWAY_RESTART_FAILED",
    );
  }
  result.steps.gatewayRestart = "passed";
  result.steps.rollback = "not_needed";
  result.status = "activated";
  return result;
}

export function parseActivationArguments(args) {
  if (args.length === 0) return { valid: true, apply: false };
  if (args.length === 1 && args[0] === "--apply") return { valid: true, apply: true };
  return { valid: false, apply: false };
}

export function invalidArgumentsResult() {
  return fail(makeResult(), "ARGUMENTS_INVALID");
}
