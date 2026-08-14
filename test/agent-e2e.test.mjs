import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAgentE2EArguments,
  runAgentE2E,
} from "../scripts/lib/agent-e2e.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const RECIPIENT = "+14155550101";
const OPENCLAW = "/opt/tools/openclaw";
const IMSG = "/opt/tools/imsg";
const DATABASE = "/private/Messages/chat.db";
const MODEL = "openrouter/auto";
const EXPECTED = `TEST: OpenClaw agent automation verification ${UUID}. No response needed.`;
const PROMPT = [
  "Do not call tools and do not send or deliver any message.",
  "Return exactly one plain-text response with no markdown, quotes, prefix, suffix, or explanation.",
  "Your entire response must be exactly:",
  EXPECTED,
].join("\n");
const ENV = {
  OPENCLAW_CLI_PATH: OPENCLAW,
  OPENCLAW_E2E_MODEL: MODEL,
  IMSG_CLI_PATH: IMSG,
  IMESSAGE_DB_PATH: DATABASE,
  IMESSAGE_E2E_RECIPIENT: RECIPIENT,
  IMESSAGE_E2E_ALLOWLIST: `${RECIPIENT},operator@real-domain.test`,
  IMESSAGE_E2E_CONFIRM: "SEND_ONE_AGENT_E2E_MESSAGE",
};
const AGENT_ARGS = [
  "agent",
  "--agent",
  "main",
  "--model",
  MODEL,
  "--session-key",
  `imessage-e2e-${UUID}`,
  "--message",
  PROMPT,
  "--json",
];
const SEND_ARGS = [
  "message",
  "send",
  "--channel",
  "imessage",
  "--target",
  `imessage:${RECIPIENT}`,
  "--message",
  EXPECTED,
  "--json",
];
const SEARCH_ARGS = [
  "search",
  "--query",
  EXPECTED,
  "--match",
  "exact",
  "--limit",
  "10",
  "--db",
  DATABASE,
  "--json",
];

function agentSuccess(text = EXPECTED) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      runId: "PRIVATE-RUN-ID",
      status: "ok",
      summary: "completed",
      result: {
        payloads: [{ text }],
        meta: { agentMeta: { status: "ok", sessionId: "PRIVATE-SESSION-ID" } },
      },
    }),
    stderr: "",
  };
}

function sendSuccess() {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      action: "send",
      channel: "imessage",
      dryRun: false,
      handledBy: "plugin",
      payload: {
        messageId: "PRIVATE-MESSAGE-ID",
        guid: "PRIVATE-GUID",
        sentText: EXPECTED,
      },
    }),
    stderr: "",
  };
}

function searchSuccess(rows = [{
  text: EXPECTED,
  is_from_me: true,
  chat_identifier: RECIPIENT,
  is_group: false,
  guid: "PRIVATE-DB-GUID",
}]) {
  return { exitCode: 0, stdout: rows.map((row) => JSON.stringify(row)).join("\n"), stderr: "" };
}

function fakeRunner(results = [agentSuccess(), sendSuccess(), searchSuccess()]) {
  const calls = [];
  let index = 0;
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      const next = results[index++];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

async function e2e(options = {}) {
  return runAgentE2E({
    env: ENV,
    uuidFactory: () => UUID,
    ...options,
  });
}

test("dry run validates inputs and invokes no command", async () => {
  const runner = fakeRunner();
  assert.deepEqual(await e2e({ runner }), { status: "dry_run", errorCodes: [] });
  assert.deepEqual(runner.calls, []);
});

test("CLI accepts only default dry run or explicit --send", () => {
  assert.deepEqual(parseAgentE2EArguments([]), { valid: true, send: false });
  assert.deepEqual(parseAgentE2EArguments(["--send"]), { valid: true, send: true });
  assert.deepEqual(parseAgentE2EArguments(["--deliver"]), { valid: false, send: false });
  assert.deepEqual(parseAgentE2EArguments(["--send", "extra"]), { valid: false, send: false });
});

test("exact recipient, allowlist, confirmation, and absolute paths gate execution", async () => {
  const cases = [
    [{ ...ENV, IMESSAGE_E2E_RECIPIENT: "*" }, "E2E_RECIPIENT_INVALID"],
    [{ ...ENV, IMESSAGE_E2E_RECIPIENT: "chat_id:42" }, "E2E_RECIPIENT_INVALID"],
    [{ ...ENV, IMESSAGE_E2E_ALLOWLIST: "operator@real-domain.test" }, "E2E_RECIPIENT_NOT_ALLOWLISTED"],
    [{ ...ENV, IMESSAGE_E2E_ALLOWLIST: `${RECIPIENT},*` }, "E2E_ALLOWLIST_INVALID"],
    [{ ...ENV, IMESSAGE_E2E_CONFIRM: "SEND_ONE_TEST_MESSAGE" }, "E2E_SEND_CONFIRMATION_REQUIRED"],
    [{ ...ENV, OPENCLAW_CLI_PATH: "openclaw" }, "OPENCLAW_CLI_PATH_INVALID"],
    [{ ...ENV, OPENCLAW_CLI_PATH: "/absolute/path/to/openclaw" }, "OPENCLAW_CLI_PATH_INVALID"],
    [{ ...ENV, IMSG_CLI_PATH: "<path-to-imsg>" }, "IMSG_CLI_PATH_INVALID"],
    [{ ...ENV, IMESSAGE_DB_PATH: "relative/chat.db" }, "IMESSAGE_DB_PATH_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "" }, "OPENCLAW_E2E_MODEL_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "gpt-5" }, "OPENCLAW_E2E_MODEL_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "openrouter/*" }, "OPENCLAW_E2E_MODEL_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "openrouter/model/" }, "OPENCLAW_E2E_MODEL_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "openrouter//model" }, "OPENCLAW_E2E_MODEL_INVALID"],
    [{ ...ENV, OPENCLAW_E2E_MODEL: "<provider/model>" }, "OPENCLAW_E2E_MODEL_INVALID"],
  ];
  for (const [env, code] of cases) {
    const runner = fakeRunner();
    const result = await e2e({ send: true, env, runner });
    assert.deepEqual(result.errorCodes, [code]);
    assert.deepEqual(runner.calls, []);
  }
});

test("healthy flow uses exact argv and agent turn never requests delivery", async () => {
  const runner = fakeRunner();
  const result = await e2e({ send: true, runner });
  assert.deepEqual(result, { status: "verified", errorCodes: [] });
  assert.deepEqual(runner.calls, [
    { command: OPENCLAW, args: AGENT_ARGS },
    { command: OPENCLAW, args: SEND_ARGS },
    { command: IMSG, args: SEARCH_ARGS },
  ]);
  assert.equal(runner.calls[0].args.includes("--deliver"), false);
  assert.equal(runner.calls[0].args.includes(RECIPIENT), false);
});

test("agent response must be exactly one byte-exact text payload", async () => {
  const variants = [
    agentSuccess(`${EXPECTED}\n`),
    { ...agentSuccess(), stdout: JSON.stringify({ status: "ok", result: { payloads: [{ text: EXPECTED }, { text: EXPECTED }] } }) },
    { ...agentSuccess(), stdout: JSON.stringify({ status: "ok", result: { payloads: [{ text: EXPECTED, mediaUrl: "/private/file" }] } }) },
    { ...agentSuccess(), stdout: JSON.stringify({ status: "error", result: { payloads: [{ text: EXPECTED }] } }) },
    { exitCode: 0, stdout: "not-json private response", stderr: "" },
  ];
  for (const variant of variants) {
    const runner = fakeRunner([variant]);
    const result = await e2e({ send: true, runner });
    assert.ok(["response_rejected", "agent_outcome_unknown"].includes(result.status));
    assert.equal(runner.calls.length, 1);
  }
});

test("message send requires documented outer envelope and observed iMessage payload", async () => {
  const invalidPayloads = [
    { success: true },
    { action: "send", channel: "imessage", dryRun: true, handledBy: "dry-run", payload: {} },
    { action: "send", channel: "imessage", dryRun: false, handledBy: "plugin", payload: { messageId: "id" } },
    { action: "send", channel: "sms", dryRun: false, handledBy: "plugin", payload: { messageId: "id", sentText: EXPECTED } },
  ];
  for (const payload of invalidPayloads) {
    const runner = fakeRunner([
      agentSuccess(),
      { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" },
    ]);
    const result = await e2e({ send: true, runner });
    assert.deepEqual(result.errorCodes, ["E2E_SEND_OUTCOME_UNCERTAIN"]);
    assert.equal(runner.calls.length, 2);
  }
});

test("DB verification requires exactly one outgoing exact-recipient row", async () => {
  const cases = [
    [[], "E2E_VERIFICATION_NOT_FOUND"],
    [[{ text: EXPECTED, is_from_me: false, chat_identifier: RECIPIENT }], "E2E_VERIFICATION_WRONG_DIRECTION"],
    [[{ text: EXPECTED, is_from_me: true, chat_identifier: "other@real-domain.test" }], "E2E_VERIFICATION_WRONG_RECIPIENT"],
    [[
      { text: EXPECTED, is_from_me: true, chat_identifier: RECIPIENT },
      { text: EXPECTED, is_from_me: true, chat_identifier: RECIPIENT },
    ], "E2E_VERIFICATION_DUPLICATE"],
  ];
  for (const [rows, code] of cases) {
    const runner = fakeRunner([agentSuccess(), sendSuccess(), searchSuccess(rows)]);
    const result = await e2e({ send: true, runner });
    assert.equal(result.status, "sent_unverified");
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(runner.calls.length, 3);
  }
});

test("agent and send failures, timeouts, and uncertainty never retry", async () => {
  const cases = [
    [[{ exitCode: 1, stdout: "", stderr: "private agent failure" }], "AGENT_RUN_FAILED", 1],
    [[{ exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }], "AGENT_RUN_TIMEOUT", 1],
    [[{ exitCode: 1, stdout: "", stderr: "gateway may have accepted run" }], "AGENT_RUN_OUTCOME_UNCERTAIN", 1],
    [[agentSuccess(), { exitCode: 1, stdout: "", stderr: "private send failure" }], "E2E_SEND_FAILED", 2],
    [[agentSuccess(), { exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }], "E2E_SEND_TIMEOUT", 2],
    [[agentSuccess(), { exitCode: 1, stdout: "", stderr: "still_in_flight" }], "E2E_SEND_OUTCOME_UNCERTAIN", 2],
  ];
  for (const [results, code, callCount] of cases) {
    const runner = fakeRunner(results);
    const result = await e2e({ send: true, runner });
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(runner.calls.length, callCount);
  }
});

test("verification failures do not cause another send", async () => {
  for (const searchResult of [
    { exitCode: 1, stdout: "", stderr: "private db failure" },
    { exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" },
    { exitCode: 0, stdout: "private malformed row", stderr: "" },
  ]) {
    const runner = fakeRunner([agentSuccess(), sendSuccess(), searchResult]);
    const result = await e2e({ send: true, runner });
    assert.equal(result.status, "sent_unverified");
    assert.equal(runner.calls.filter((call) => call.args[0] === "message").length, 1);
  }
});

test("outputs never expose private values from any stage", async () => {
  const privateDiagnostic = `${RECIPIENT} ${EXPECTED} ${DATABASE} PRIVATE-RUN-ID PRIVATE-MESSAGE-ID`;
  const runner = fakeRunner([
    agentSuccess(),
    { exitCode: 1, stdout: privateDiagnostic, stderr: privateDiagnostic },
  ]);
  const result = await e2e({ send: true, runner });
  const serialized = JSON.stringify(result);
  for (const value of [
    RECIPIENT,
    EXPECTED,
    DATABASE,
    MODEL,
    UUID,
    "PRIVATE-RUN-ID",
    "PRIVATE-MESSAGE-ID",
  ]) {
    assert.equal(serialized.includes(value), false);
  }
  assert.deepEqual(Object.keys(result), ["status", "errorCodes"]);
});
