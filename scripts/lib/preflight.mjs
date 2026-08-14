import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const REQUIRED_OPENCLAW_ENGINE_FLOOR = [22, 19, 0];
const CHECK_NAMES = [
  "platform",
  "node",
  "openclaw",
  "imsg",
  "sip",
  "basicMode",
  "imessagePlugin",
  "messageDatabase",
];

function createResult() {
  return {
    status: "blocked",
    checks: Object.fromEntries(CHECK_NAMES.map((name) => [name, { status: "pending" }])),
    errorCodes: [],
  };
}

function pass(result, check, details = {}) {
  result.checks[check] = { status: "pass", ...details };
}

function fail(result, check, code) {
  result.checks[check] = { status: "fail" };
  if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
}

function parseVersion(value) {
  const match = String(value).match(/(?:^|\s)[vV]?(\d+)\.(\d+)\.(\d+)(?=\s|$|\()/);
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseMinimumEngine(value) {
  const match = String(value).match(/^\s*>=\s*(\d+)\.(\d+)(?:\.(\d+))?\s*$/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

function isAuthorizationDenied(result) {
  const diagnostic = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return /full disk access|operation not permitted|permission denied|not authori[sz]ed|authorization denied|tcc/i.test(
    diagnostic,
  );
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function countChats(output) {
  const trimmed = output.trim();
  if (!trimmed) return 0;

  const parsed = parseJson(trimmed);
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") {
    if (Array.isArray(parsed.chats)) return parsed.chats.length;
    return 1;
  }

  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  if (lines.length > 1 && lines.every((line) => {
    const item = parseJson(line);
    return item && typeof item === "object";
  })) {
    return lines.length;
  }

  return null;
}

async function readJsonFile(filePath, readFileImpl = readFile) {
  return JSON.parse(await readFileImpl(filePath, "utf8"));
}

export function createCommandRunner({ timeoutMs = 10_000, env = process.env } = {}) {
  return {
    async run(command, args) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn(command, args, {
          env,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode: null, stdout: "", stderr: "", errorCode: error.code });
        });
        child.on("close", (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ exitCode, stdout, stderr });
        });
      });
    },

    async resolve(command) {
      for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
        const candidate = path.join(directory, command);
        try {
          await access(candidate, constants.X_OK);
          return await realpath(candidate);
        } catch {
          // Continue searching PATH without exposing candidate paths.
        }
      }
      return null;
    },
  };
}

export async function inspectOpenClawInstallation(runner, readFileImpl = readFile) {
  const executable = await runner.resolve?.("openclaw");
  if (!executable) return { found: false };

  let directory = path.dirname(executable);
  let packageRoot = null;
  let packageJson = null;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const candidate = await readJsonFile(path.join(directory, "package.json"), readFileImpl);
      if (candidate.name === "openclaw") {
        packageRoot = directory;
        packageJson = candidate;
        break;
      }
    } catch {
      // Executable may be nested below package root.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  if (!packageRoot) return { found: false };

  let pluginExists = false;
  try {
    const plugin = await readJsonFile(
      path.join(packageRoot, "dist", "extensions", "imessage", "package.json"),
      readFileImpl,
    );
    pluginExists = plugin.name === "@openclaw/imessage";
  } catch {
    pluginExists = false;
  }

  return {
    found: true,
    packageVersion: packageJson.version,
    engineRange: packageJson.engines?.node,
    pluginExists,
  };
}

export async function runPreflight({
  runner = createCommandRunner(),
  platform = process.platform,
  nodeVersion = process.version,
  versionsPath = path.resolve("versions.json"),
  installationProbe = inspectOpenClawInstallation,
  readFileImpl = readFile,
} = {}) {
  const result = createResult();

  let pins;
  try {
    pins = await readJsonFile(versionsPath, readFileImpl);
    if (typeof pins.openclaw !== "string" || typeof pins.imsg !== "string") throw new Error();
  } catch {
    for (const check of CHECK_NAMES) fail(result, check, "VERSIONS_FILE_INVALID");
    return result;
  }

  if (platform === "darwin") pass(result, "platform");
  else fail(result, "platform", "MACOS_REQUIRED");

  const [openclawCommand, imsgCommand, sipCommand, statusCommand, chatsCommand, installation] =
    await Promise.all([
      runner.run("openclaw", ["--version"]),
      runner.run("imsg", ["--version"]),
      runner.run("csrutil", ["status"]),
      runner.run("imsg", ["status", "--json"]),
      runner.run("imsg", ["chats", "--limit", "1", "--json"]),
      installationProbe(runner, readFileImpl),
    ]);

  const cliOpenClawVersion = parseVersion(openclawCommand.stdout);
  if (
    openclawCommand.exitCode === 0 &&
    cliOpenClawVersion &&
    cliOpenClawVersion.join(".") === pins.openclaw &&
    installation.found &&
    installation.packageVersion === pins.openclaw
  ) {
    pass(result, "openclaw");
  } else if (openclawCommand.errorCode === "ENOENT" || !installation.found) {
    fail(result, "openclaw", "OPENCLAW_NOT_FOUND");
  } else {
    fail(result, "openclaw", "OPENCLAW_VERSION_MISMATCH");
  }

  const engineMinimum = parseMinimumEngine(installation.engineRange);
  const currentNode = parseVersion(nodeVersion);
  if (!engineMinimum || compareVersions(engineMinimum, REQUIRED_OPENCLAW_ENGINE_FLOOR) < 0) {
    fail(result, "node", "OPENCLAW_NODE_ENGINE_INVALID");
  } else if (!currentNode || compareVersions(currentNode, engineMinimum) < 0) {
    fail(result, "node", "NODE_VERSION_UNSUPPORTED");
  } else {
    pass(result, "node");
  }

  const cliImsgVersion = parseVersion(imsgCommand.stdout);
  if (imsgCommand.exitCode === 0 && cliImsgVersion?.join(".") === pins.imsg) {
    pass(result, "imsg");
  } else if (imsgCommand.errorCode === "ENOENT") {
    fail(result, "imsg", "IMSG_NOT_FOUND");
  } else {
    fail(result, "imsg", "IMSG_VERSION_MISMATCH");
  }

  if (sipCommand.exitCode !== 0) fail(result, "sip", "SIP_STATUS_UNAVAILABLE");
  else if (/status:\s*enabled\.?/i.test(sipCommand.stdout)) pass(result, "sip");
  else fail(result, "sip", "SIP_DISABLED");

  if (statusCommand.exitCode !== 0 && isAuthorizationDenied(statusCommand)) {
    fail(result, "basicMode", "FULL_DISK_ACCESS_REQUIRED");
  } else if (statusCommand.exitCode !== 0) {
    fail(result, "basicMode", "IMSG_STATUS_UNAVAILABLE");
  } else {
    const status = parseJson(statusCommand.stdout);
    if (!status || typeof status !== "object") {
      fail(result, "basicMode", "IMSG_STATUS_MALFORMED");
    } else if (status.basic_features !== true) {
      fail(result, "basicMode", "IMSG_BASIC_FEATURES_REQUIRED");
    } else if (status.advanced_features !== false) {
      fail(result, "basicMode", "IMSG_ADVANCED_FEATURES_MUST_BE_DISABLED");
    } else {
      pass(result, "basicMode");
    }
  }

  if (installation.pluginExists) pass(result, "imessagePlugin");
  else fail(result, "imessagePlugin", "OPENCLAW_IMESSAGE_PLUGIN_NOT_FOUND");

  if (chatsCommand.exitCode !== 0 && isAuthorizationDenied(chatsCommand)) {
    fail(result, "messageDatabase", "FULL_DISK_ACCESS_REQUIRED");
  } else if (chatsCommand.exitCode !== 0) {
    fail(result, "messageDatabase", "IMESSAGE_DATABASE_READ_FAILED");
  } else {
    const count = countChats(chatsCommand.stdout);
    if (count === null) fail(result, "messageDatabase", "IMESSAGE_CHATS_OUTPUT_MALFORMED");
    else pass(result, "messageDatabase", { count });
  }

  if (Object.values(result.checks).every((check) => check.status === "pass")) {
    result.status = "ready";
  }
  return result;
}
