import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";

const CONFIRMATION = "SEND_ONE_TEST_MESSAGE";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

function result(status, errorCodes = [], correlation) {
  return {
    status,
    ...(correlation ? { correlation } : {}),
    errorCodes,
  };
}

function isExactRecipient(value) {
  return E164_PATTERN.test(value) || EMAIL_PATTERN.test(value);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRows(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) return [];

  const collect = (value) => {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object") return null;
    for (const key of ["messages", "results", "rows"]) {
      if (Array.isArray(value[key])) return value[key];
    }
    return [value];
  };

  const whole = parseJson(trimmed);
  if (whole !== null) return collect(whole);

  const rows = [];
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    const parsed = parseJson(line);
    const items = collect(parsed);
    if (items === null) return null;
    rows.push(...items);
  }
  return rows;
}

function sendJsonIsUncertain(value) {
  if (!value || typeof value !== "object") return false;
  if (value.uncertain === true || value.may_have_completed === true) return true;
  for (const key of ["status", "outcome", "certainty", "disposition"]) {
    if (
      typeof value[key] === "string" &&
      /uncertain|unknown|indeterminate|may_have_completed|still_in_flight/i.test(value[key])
    ) {
      return true;
    }
  }
  return Object.values(value).some((item) => item && typeof item === "object" && sendJsonIsUncertain(item));
}

function failedSendIsUncertain(commandResult) {
  const diagnostic = `${commandResult?.stdout ?? ""}\n${commandResult?.stderr ?? ""}`;
  return /\b(?:may_have_completed|still_in_flight)\b/i.test(diagnostic);
}

function timedOut(commandResult) {
  return commandResult?.errorCode === "ETIMEDOUT" || commandResult?.timedOut === true;
}

export function createCommandRunner({ timeoutMs = 15_000, env = process.env } = {}) {
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
        const finish = (commandResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(commandResult);
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
  };
}

export async function runLiveSmoke({
  send = false,
  env = process.env,
  runner = createCommandRunner(),
  uuidFactory = randomUUID,
} = {}) {
  const recipient = env.IMESSAGE_TEST_RECIPIENT;
  if (typeof recipient !== "string" || recipient.length === 0) {
    return result("blocked", ["TEST_RECIPIENT_REQUIRED"]);
  }
  if (recipient !== recipient.trim() || !isExactRecipient(recipient)) {
    return result("blocked", ["TEST_RECIPIENT_INVALID"]);
  }

  const rawAllowlist = env.IMESSAGE_TEST_ALLOWLIST;
  if (typeof rawAllowlist !== "string" || rawAllowlist.trim() === "") {
    return result("blocked", ["TEST_ALLOWLIST_REQUIRED"]);
  }
  const allowlist = rawAllowlist.split(",").map((item) => item.trim());
  if (allowlist.some((item) => !isExactRecipient(item))) {
    return result("blocked", ["TEST_ALLOWLIST_INVALID"]);
  }
  if (!allowlist.includes(recipient)) {
    return result("blocked", ["TEST_RECIPIENT_NOT_ALLOWLISTED"]);
  }

  if (!send) return result("dry_run");
  if (env.IMESSAGE_TEST_CONFIRM !== CONFIRMATION) {
    return result("blocked", ["TEST_SEND_CONFIRMATION_REQUIRED"]);
  }

  let correlation;
  try {
    correlation = uuidFactory();
  } catch {
    return result("blocked", ["CORRELATION_GENERATION_FAILED"]);
  }
  if (typeof correlation !== "string" || !UUID_PATTERN.test(correlation)) {
    return result("blocked", ["CORRELATION_GENERATION_FAILED"]);
  }
  const body = `TEST: OpenClaw iMessage transport verification ${correlation}. No response needed.`;

  let sendResult;
  try {
    sendResult = await runner.run("imsg", [
      "send",
      "--to",
      recipient,
      "--text",
      body,
      "--service",
      "imessage",
      "--no-sms-fallback",
      "--json",
    ]);
  } catch {
    return result("send_failed", ["SEND_FAILED"]);
  }

  if (timedOut(sendResult)) return result("send_outcome_unknown", ["SEND_TIMEOUT"]);
  if (!sendResult || sendResult.exitCode !== 0) {
    if (failedSendIsUncertain(sendResult)) {
      return result("send_outcome_unknown", ["SEND_OUTCOME_UNCERTAIN"]);
    }
    return result("send_failed", ["SEND_FAILED"]);
  }

  const sendJson = parseJson(sendResult.stdout);
  if (!sendJson || typeof sendJson !== "object") {
    return result("send_outcome_unknown", ["SEND_OUTCOME_UNCERTAIN"]);
  }
  if (sendJsonIsUncertain(sendJson)) {
    return result("send_outcome_unknown", ["SEND_OUTCOME_UNCERTAIN"]);
  }
  if (sendJson.status !== "sent") {
    return result("send_outcome_unknown", ["SEND_OUTCOME_UNCERTAIN"]);
  }

  let searchResult;
  try {
    searchResult = await runner.run("imsg", [
      "search",
      "--query",
      body,
      "--match",
      "exact",
      "--limit",
      "10",
      "--json",
    ]);
  } catch {
    return result("sent_unverified", ["VERIFICATION_FAILED"]);
  }

  if (timedOut(searchResult)) return result("sent_unverified", ["VERIFICATION_TIMEOUT"]);
  if (!searchResult || searchResult.exitCode !== 0) {
    return result("sent_unverified", ["VERIFICATION_FAILED"]);
  }

  const rows = parseRows(searchResult.stdout);
  if (rows === null || rows.some((row) => !row || typeof row !== "object")) {
    return result("sent_unverified", ["VERIFICATION_RESULT_MALFORMED"]);
  }
  const exactRows = rows.filter((row) => row.text === body);
  const outgoingRows = exactRows.filter((row) => row.is_from_me === true);
  if (outgoingRows.length > 1) {
    return result("sent_unverified", ["VERIFICATION_DUPLICATE"]);
  }
  if (outgoingRows.length === 0 && exactRows.length > 0) {
    return result("sent_unverified", ["VERIFICATION_WRONG_DIRECTION"]);
  }
  if (outgoingRows.length === 0) {
    return result("sent_unverified", ["VERIFICATION_NOT_FOUND"]);
  }

  return result("verified", [], correlation);
}

export function parseLiveSmokeArguments(args) {
  if (args.length === 0) return { valid: true, send: false };
  if (args.length === 1 && args[0] === "--send") return { valid: true, send: true };
  return { valid: false, send: false };
}

export function invalidArgumentsResult() {
  return result("blocked", ["ARGUMENTS_INVALID"]);
}
