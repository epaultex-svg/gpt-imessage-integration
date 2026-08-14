import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const SERVER_NAME = "openclaw";
const AGENT_NAMES = ["codex", "claude"];

const AGENTS = {
  codex: {
    inspect: ["mcp", "get", SERVER_NAME, "--json"],
    add(openclawPath) {
      return ["mcp", "add", SERVER_NAME, "--", openclawPath, "mcp", "serve", "--claude-channel-mode", "off"];
    },
    expectedArgs: ["mcp", "serve", "--claude-channel-mode", "off"],
  },
  claude: {
    inspect: ["mcp", "get", SERVER_NAME],
    add(openclawPath) {
      return ["mcp", "add", "--scope", "user", SERVER_NAME, "--", openclawPath, "mcp", "serve", "--claude-channel-mode", "on"];
    },
    expectedArgs: ["mcp", "serve", "--claude-channel-mode", "on"],
  },
};

function initialResult() {
  return {
    status: "blocked",
    agents: Object.fromEntries(AGENT_NAMES.map((name) => [name, { status: "not_checked" }])),
    errorCodes: [],
  };
}

function addError(result, code) {
  if (!result.errorCodes.includes(code)) result.errorCodes.push(code);
}

function stripAnsi(value) {
  // Covers CSI color/control sequences commonly emitted by the agent CLIs.
  return String(value ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isAbsent(agent, commandResult) {
  if (commandResult.exitCode === 0) return false;
  const diagnostic = stripAnsi(`${commandResult.stdout ?? ""}\n${commandResult.stderr ?? ""}`);
  if (/no\s+mcp\s+server\s+named\s+["']?openclaw["']?(?:\s+found)?/i.test(diagnostic)) {
    return true;
  }
  if (agent === "codex") {
    return /(?:mcp\s+server|server|configuration).{0,80}(?:openclaw).{0,80}(?:not\s+found|does\s+not\s+exist|unknown)/is.test(diagnostic) ||
      /(?:not\s+found|does\s+not\s+exist|unknown).{0,80}(?:mcp\s+server|server|configuration).{0,80}(?:openclaw)/is.test(diagnostic);
  }
  return /(?:mcp\s+server|server).{0,80}(?:openclaw).{0,80}(?:not\s+found|does\s+not\s+exist|unknown)/is.test(diagnostic) ||
    /(?:not\s+found|does\s+not\s+exist|unknown).{0,80}(?:mcp\s+server|server).{0,80}(?:openclaw)/is.test(diagnostic);
}

function emptyValue(value) {
  return value === undefined || value === null || value === "" ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);
}

function parseCodexConfig(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const transport = parsed.transport && typeof parsed.transport === "object"
    ? parsed.transport
    : parsed;
  const stdio = transport.stdio && typeof transport.stdio === "object"
    ? transport.stdio
    : transport;
  return {
    type: transport.type ?? parsed.type ?? "stdio",
    command: stdio.command ?? parsed.command,
    args: stdio.args ?? parsed.args,
    cwd: stdio.cwd ?? transport.cwd ?? parsed.cwd,
    env: stdio.env ?? transport.env ?? parsed.env,
    envVars: stdio.env_vars ?? transport.env_vars ?? parsed.env_vars,
    enabled: parsed.enabled,
  };
}

function codexIsExact(stdout, openclawPath) {
  const config = parseCodexConfig(stdout);
  return config !== null &&
    config.type === "stdio" &&
    config.command === openclawPath &&
    Array.isArray(config.args) &&
    config.args.length === AGENTS.codex.expectedArgs.length &&
    config.args.every((arg, index) => arg === AGENTS.codex.expectedArgs[index]) &&
    emptyValue(config.cwd) &&
    emptyValue(config.env) &&
    emptyValue(config.envVars) &&
    (config.enabled === undefined || config.enabled === true);
}

function claudeFields(stdout) {
  const fields = new Map();
  let currentField = null;
  for (const rawLine of stripAnsi(stdout).split(/\r?\n/)) {
    const match = rawLine.match(/^\s{0,8}([A-Za-z][A-Za-z ]*):(?:\s*(.*))?$/);
    if (match) {
      currentField = match[1].trim().toLowerCase();
      fields.set(currentField, (match[2] ?? "").trim());
      continue;
    }
    if (currentField === "environment" && rawLine.trim()) {
      fields.set("environment", `${fields.get("environment")}\n${rawLine.trim()}`.trim());
    }
  }
  return fields;
}

function claudeIsExact(stdout, openclawPath) {
  const fields = claudeFields(stdout);
  const environment = fields.get("environment");
  return /^user(?:\s|$)/i.test(fields.get("scope") ?? "") &&
    (fields.get("type") ?? "").toLowerCase() === "stdio" &&
    fields.get("command") === openclawPath &&
    fields.get("args") === AGENTS.claude.expectedArgs.join(" ") &&
    (environment === undefined || environment === "" || /^(?:none|\(none\))$/i.test(environment));
}

async function inspectAgent(agent, runner, openclawPath) {
  let commandResult;
  try {
    commandResult = await runner.run(agent, AGENTS[agent].inspect);
  } catch {
    return { status: "inspection_failed" };
  }
  if (!commandResult || typeof commandResult !== "object") return { status: "inspection_failed" };
  if (isAbsent(agent, commandResult)) return { status: "add_required" };
  if (commandResult.exitCode !== 0) return { status: "inspection_failed" };

  const exact = agent === "codex"
    ? codexIsExact(commandResult.stdout, openclawPath)
    : claudeIsExact(commandResult.stdout, openclawPath);
  return { status: exact ? "noop" : "conflict" };
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
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" });
        }, timeoutMs);

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", (error) => {
          finish({ exitCode: null, stdout: "", stderr: "", errorCode: error.code });
        });
        child.on("close", (exitCode) => {
          finish({ exitCode, stdout, stderr });
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
          // Continue without exposing candidate paths.
        }
      }
      return null;
    },
  };
}

export async function configureAgentMcp({
  apply = false,
  runner = createCommandRunner(),
  openclawPath,
} = {}) {
  const result = initialResult();

  let resolvedPath = openclawPath;
  try {
    resolvedPath ??= await runner.resolve?.("openclaw");
  } catch {
    resolvedPath = null;
  }
  if (!resolvedPath) {
    addError(result, "OPENCLAW_NOT_FOUND");
    return result;
  }
  if (!path.isAbsolute(resolvedPath)) {
    addError(result, "OPENCLAW_PATH_INVALID");
    return result;
  }

  const inspections = await Promise.all(
    AGENT_NAMES.map((agent) => inspectAgent(agent, runner, resolvedPath)),
  );
  for (let index = 0; index < AGENT_NAMES.length; index += 1) {
    const agent = AGENT_NAMES[index];
    result.agents[agent] = inspections[index];
    if (inspections[index].status === "inspection_failed") {
      addError(result, `${agent.toUpperCase()}_INSPECTION_FAILED`);
    } else if (inspections[index].status === "conflict") {
      addError(result, `${agent.toUpperCase()}_CONFIGURATION_CONFLICT`);
    }
  }

  if (result.errorCodes.length > 0) {
    for (const agent of AGENT_NAMES) {
      if (result.agents[agent].status === "add_required") {
        result.agents[agent] = { status: "not_applied" };
      }
    }
    return result;
  }

  const required = AGENT_NAMES.filter((agent) => result.agents[agent].status === "add_required");
  if (!apply) {
    for (const agent of required) result.agents[agent] = { status: "add_planned" };
    result.status = required.length === 0 ? "ready" : "changes_planned";
    return result;
  }

  for (let index = 0; index < required.length; index += 1) {
    const agent = required[index];
    let commandResult;
    try {
      commandResult = await runner.run(agent, AGENTS[agent].add(resolvedPath));
    } catch {
      commandResult = null;
    }
    if (!commandResult || commandResult.exitCode !== 0) {
      result.agents[agent] = { status: "add_failed" };
      addError(result, `${agent.toUpperCase()}_ADD_FAILED`);
      for (const remaining of required.slice(index + 1)) {
        result.agents[remaining] = { status: "not_applied" };
      }
      return result;
    }
    result.agents[agent] = { status: "added" };
  }

  result.status = required.length === 0 ? "ready" : "configured";
  return result;
}

export function parseConfigureArguments(args) {
  if (args.length === 0) return { valid: true, apply: false };
  if (args.length === 1 && args[0] === "--apply") return { valid: true, apply: true };
  return { valid: false, apply: false };
}

export function invalidArgumentsResult() {
  const result = initialResult();
  addError(result, "ARGUMENTS_INVALID");
  return result;
}
