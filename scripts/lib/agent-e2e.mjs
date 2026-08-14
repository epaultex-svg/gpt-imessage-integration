import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";

const CONFIRMATION = "SEND_ONE_AGENT_E2E_MESSAGE";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PLACEHOLDER_PATTERN = /<[^>]+>|\$\{[^}]+\}|(?:^|\/)absolute\/path(?:\/|$)|\b(?:change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ])/i;

function output(status, errorCodes = []) {
  return { status, errorCodes };
}

function exactHandle(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    !PLACEHOLDER_PATTERN.test(value) &&
    (E164_PATTERN.test(value) || EMAIL_PATTERN.test(value));
}

function exactAbsolutePath(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    path.isAbsolute(value) &&
    !PLACEHOLDER_PATTERN.test(value);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRows(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return [];
  const collect = (parsed) => {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== "object") return null;
    for (const key of ["messages", "results", "rows"]) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    return [parsed];
  };
  const whole = parseJson(trimmed);
  if (whole !== null) return collect(whole);

  const rows = [];
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    const items = collect(parseJson(line));
    if (items === null) return null;
    rows.push(...items);
  }
  return rows;
}

function timedOut(result) {
  return result?.errorCode === "ETIMEDOUT" || result?.timedOut === true;
}

function uncertain(result) {
  const diagnostic = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  return /may_have_completed|still_in_flight|\bin_flight\b|outcome.{0,20}uncertain|may have (?:accepted|sent|completed)|may still (?:finish|complete)/i.test(
    diagnostic,
  );
}

function containsUncertainty(value) {
  if (!value || typeof value !== "object") return false;
  for (const [key, item] of Object.entries(value)) {
    if (/uncertain|may_have_completed|still_in_flight/i.test(key) && item !== false && item !== null) {
      return true;
    }
    if (typeof item === "string" && /uncertain|unknown|may_have_completed|still_in_flight|in_flight/i.test(item)) {
      return true;
    }
    if (item && typeof item === "object" && containsUncertainty(item)) return true;
  }
  return false;
}

function exactAgentText(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.status !== "ok") return null;
  if (value.error || value.meta?.error || value.result?.error || value.result?.meta?.error) return null;
  const payloads = Array.isArray(value.result?.payloads) ? value.result.payloads : null;
  if (!payloads || payloads.length !== 1) return null;
  const payload = payloads[0];
  if (!payload || typeof payload !== "object" || typeof payload.text !== "string") return null;
  if (payload.error || payload.mediaUrl || (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0)) {
    return null;
  }
  if (value.final !== undefined && value.final !== payload.text) return null;
  return payload.text;
}

function sendSucceeded(value, expected) {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.action === "send" &&
    value.channel === "imessage" &&
    value.dryRun === false &&
    value.handledBy === "plugin" &&
    value.payload &&
    typeof value.payload === "object" &&
    typeof value.payload.messageId === "string" &&
    value.payload.messageId.length > 0 &&
    value.payload.sentText === expected;
}

export function createCommandRunner({ timeoutMs = 120_000, env = process.env } = {}) {
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
        child.on("close", (exitCode) => finish({ exitCode, stdout, stderr }));
      });
    },
  };
}

export async function runAgentE2E({
  send = false,
  env = process.env,
  runner = createCommandRunner(),
  uuidFactory = randomUUID,
} = {}) {
  const recipient = env.IMESSAGE_E2E_RECIPIENT;
  const rawAllowlist = env.IMESSAGE_E2E_ALLOWLIST;
  if (!exactHandle(recipient)) return output("blocked", ["E2E_RECIPIENT_INVALID"]);
  if (typeof rawAllowlist !== "string" || rawAllowlist.trim() === "") {
    return output("blocked", ["E2E_ALLOWLIST_REQUIRED"]);
  }
  const allowlist = rawAllowlist.split(",").map((item) => item.trim());
  if (allowlist.some((item) => !exactHandle(item))) {
    return output("blocked", ["E2E_ALLOWLIST_INVALID"]);
  }
  if (!allowlist.includes(recipient)) {
    return output("blocked", ["E2E_RECIPIENT_NOT_ALLOWLISTED"]);
  }
  const openclawPath = env.OPENCLAW_CLI_PATH;
  const imsgPath = env.IMSG_CLI_PATH;
  const databasePath = env.IMESSAGE_DB_PATH;
  const model = env.OPENCLAW_E2E_MODEL;
  if (!exactAbsolutePath(openclawPath)) return output("blocked", ["OPENCLAW_CLI_PATH_INVALID"]);
  if (!exactAbsolutePath(imsgPath)) return output("blocked", ["IMSG_CLI_PATH_INVALID"]);
  if (!exactAbsolutePath(databasePath)) return output("blocked", ["IMESSAGE_DB_PATH_INVALID"]);
  if (
    typeof model !== "string" ||
    model !== model.trim() ||
    PLACEHOLDER_PATTERN.test(model) ||
    !MODEL_PATTERN.test(model) ||
    model.includes("*") ||
    model.includes("//") ||
    model.endsWith("/")
  ) {
    return output("blocked", ["OPENCLAW_E2E_MODEL_INVALID"]);
  }
  if (!send) return output("dry_run");
  if (env.IMESSAGE_E2E_CONFIRM !== CONFIRMATION) {
    return output("blocked", ["E2E_SEND_CONFIRMATION_REQUIRED"]);
  }

  let correlation;
  try {
    correlation = uuidFactory();
  } catch {
    return output("blocked", ["CORRELATION_GENERATION_FAILED"]);
  }
  if (typeof correlation !== "string" || !UUID_PATTERN.test(correlation)) {
    return output("blocked", ["CORRELATION_GENERATION_FAILED"]);
  }
  const expected = `TEST: OpenClaw agent automation verification ${correlation}. No response needed.`;
  const prompt = [
    "Do not call tools and do not send or deliver any message.",
    "Return exactly one plain-text response with no markdown, quotes, prefix, suffix, or explanation.",
    "Your entire response must be exactly:",
    expected,
  ].join("\n");
  const sessionKey = `imessage-e2e-${correlation}`;

  let agentResult;
  try {
    agentResult = await runner.run(openclawPath, [
      "agent",
      "--agent",
      "main",
      "--model",
      model,
      "--session-key",
      sessionKey,
      "--message",
      prompt,
      "--json",
    ]);
  } catch {
    return output("agent_failed", ["AGENT_RUN_FAILED"]);
  }
  if (timedOut(agentResult)) return output("agent_outcome_unknown", ["AGENT_RUN_TIMEOUT"]);
  if (!agentResult || agentResult.exitCode !== 0) {
    return uncertain(agentResult)
      ? output("agent_outcome_unknown", ["AGENT_RUN_OUTCOME_UNCERTAIN"])
      : output("agent_failed", ["AGENT_RUN_FAILED"]);
  }
  const agentJson = parseJson(agentResult.stdout);
  if (!agentJson || containsUncertainty(agentJson)) {
    return output("agent_outcome_unknown", ["AGENT_RUN_OUTCOME_UNCERTAIN"]);
  }
  const responseText = exactAgentText(agentJson);
  if (responseText !== expected) return output("response_rejected", ["AGENT_RESPONSE_NOT_EXACT"]);

  let sendResult;
  try {
    sendResult = await runner.run(openclawPath, [
      "message",
      "send",
      "--channel",
      "imessage",
      "--target",
      `imessage:${recipient}`,
      "--message",
      expected,
      "--json",
    ]);
  } catch {
    return output("send_failed", ["E2E_SEND_FAILED"]);
  }
  if (timedOut(sendResult)) return output("send_outcome_unknown", ["E2E_SEND_TIMEOUT"]);
  if (!sendResult || sendResult.exitCode !== 0) {
    return uncertain(sendResult)
      ? output("send_outcome_unknown", ["E2E_SEND_OUTCOME_UNCERTAIN"])
      : output("send_failed", ["E2E_SEND_FAILED"]);
  }
  const sendJson = parseJson(sendResult.stdout);
  if (!sendJson || containsUncertainty(sendJson) || !sendSucceeded(sendJson, expected)) {
    return output("send_outcome_unknown", ["E2E_SEND_OUTCOME_UNCERTAIN"]);
  }

  let searchResult;
  try {
    searchResult = await runner.run(imsgPath, [
      "search",
      "--query",
      expected,
      "--match",
      "exact",
      "--limit",
      "10",
      "--db",
      databasePath,
      "--json",
    ]);
  } catch {
    return output("sent_unverified", ["E2E_VERIFICATION_FAILED"]);
  }
  if (timedOut(searchResult)) return output("sent_unverified", ["E2E_VERIFICATION_TIMEOUT"]);
  if (!searchResult || searchResult.exitCode !== 0) {
    return output("sent_unverified", ["E2E_VERIFICATION_FAILED"]);
  }
  const rows = parseRows(searchResult.stdout);
  if (rows === null || rows.some((row) => !row || typeof row !== "object")) {
    return output("sent_unverified", ["E2E_VERIFICATION_MALFORMED"]);
  }
  const bodyRows = rows.filter((row) => row.text === expected);
  const outgoingRows = bodyRows.filter((row) => row.is_from_me === true);
  const exactRows = outgoingRows.filter(
    (row) => row.chat_identifier === recipient && row.is_group !== true,
  );
  if (exactRows.length > 1) return output("sent_unverified", ["E2E_VERIFICATION_DUPLICATE"]);
  if (exactRows.length === 0 && outgoingRows.length > 0) {
    return output("sent_unverified", ["E2E_VERIFICATION_WRONG_RECIPIENT"]);
  }
  if (exactRows.length === 0 && bodyRows.length > 0) {
    return output("sent_unverified", ["E2E_VERIFICATION_WRONG_DIRECTION"]);
  }
  if (exactRows.length === 0) return output("sent_unverified", ["E2E_VERIFICATION_NOT_FOUND"]);
  return output("verified");
}

export function parseAgentE2EArguments(args) {
  if (args.length === 0) return { valid: true, send: false };
  if (args.length === 1 && args[0] === "--send") return { valid: true, send: true };
  return { valid: false, send: false };
}

export function invalidArgumentsResult() {
  return output("blocked", ["ARGUMENTS_INVALID"]);
}
