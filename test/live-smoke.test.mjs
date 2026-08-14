import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLiveSmokeArguments,
  runLiveSmoke,
} from "../scripts/lib/live-smoke.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const RECIPIENT = "+14155550101";
const BODY = `TEST: OpenClaw iMessage transport verification ${UUID}. No response needed.`;
const SAFE_ENV = {
  IMESSAGE_TEST_RECIPIENT: RECIPIENT,
  IMESSAGE_TEST_ALLOWLIST: `${RECIPIENT},tester@example.net`,
  IMESSAGE_TEST_CONFIRM: "SEND_ONE_TEST_MESSAGE",
};
const SEND_ARGS = [
  "send",
  "--to",
  RECIPIENT,
  "--text",
  BODY,
  "--service",
  "imessage",
  "--no-sms-fallback",
  "--json",
];
const SEARCH_ARGS = [
  "search",
  "--query",
  BODY,
  "--match",
  "exact",
  "--limit",
  "10",
  "--json",
];

function runnerWith({
  sendResult = {
    exitCode: 0,
    stdout: '{"status":"sent","id":42,"guid":"PRIVATE-SEND-GUID","message_id":"PRIVATE-ID"}',
    stderr: "",
  },
  searchResult = {
    exitCode: 0,
    stdout: JSON.stringify({ text: BODY, is_from_me: true, guid: "PRIVATE-GUID" }),
    stderr: "",
  },
} = {}) {
  const calls = [];
  return {
    calls,
    async run(command, args) {
      calls.push({ command, args: [...args] });
      return args[0] === "send" ? sendResult : searchResult;
    },
  };
}

async function smoke(options = {}) {
  return runLiveSmoke({
    env: SAFE_ENV,
    uuidFactory: () => UUID,
    ...options,
  });
}

test("dry run validates target without invoking commands", async () => {
  const runner = runnerWith();
  const result = await smoke({ send: false, runner });
  assert.deepEqual(result, { status: "dry_run", errorCodes: [] });
  assert.deepEqual(runner.calls, []);
});

test("CLI parser permits only default dry run or explicit --send", () => {
  assert.deepEqual(parseLiveSmokeArguments([]), { valid: true, send: false });
  assert.deepEqual(parseLiveSmokeArguments(["--send"]), { valid: true, send: true });
  assert.deepEqual(parseLiveSmokeArguments(["--text", "anything"]), { valid: false, send: false });
  assert.deepEqual(parseLiveSmokeArguments(["--send", "extra"]), { valid: false, send: false });
});

test("send requires exact confirmation and allowlist membership", async () => {
  const cases = [
    [{ ...SAFE_ENV, IMESSAGE_TEST_CONFIRM: "yes" }, "TEST_SEND_CONFIRMATION_REQUIRED"],
    [{ ...SAFE_ENV, IMESSAGE_TEST_ALLOWLIST: "tester@example.net" }, "TEST_RECIPIENT_NOT_ALLOWLISTED"],
    [{ ...SAFE_ENV, IMESSAGE_TEST_RECIPIENT: "chat_id:42" }, "TEST_RECIPIENT_INVALID"],
    [{ ...SAFE_ENV, IMESSAGE_TEST_RECIPIENT: "*" }, "TEST_RECIPIENT_INVALID"],
    [{ ...SAFE_ENV, IMESSAGE_TEST_ALLOWLIST: `${RECIPIENT},*` }, "TEST_ALLOWLIST_INVALID"],
  ];
  for (const [env, code] of cases) {
    const runner = runnerWith();
    const result = await smoke({ send: true, env, runner });
    assert.ok(result.errorCodes.includes(code));
    assert.deepEqual(runner.calls, []);
  }
});

test("send body has fixed TEST prefix and exact argv with no SMS fallback", async () => {
  const runner = runnerWith();
  const result = await smoke({ send: true, runner });
  assert.equal(result.status, "verified");
  assert.deepEqual(runner.calls, [
    { command: "imsg", args: SEND_ARGS },
    { command: "imsg", args: SEARCH_ARGS },
  ]);
  assert.match(runner.calls[0].args[4], /^TEST: OpenClaw iMessage transport verification /);
});

test("successful JSON and NDJSON verification exposes correlation only", async () => {
  const privateData = "private@example.net";
  const runner = runnerWith({
    searchResult: {
      exitCode: 0,
      stdout: [
        JSON.stringify({ text: "unrelated private message", is_from_me: false, handle: privateData }),
        JSON.stringify({ text: BODY, is_from_me: true, guid: "PRIVATE-GUID", handle: privateData }),
      ].join("\n"),
      stderr: "",
    },
  });
  const result = await smoke({ send: true, runner });
  assert.deepEqual(result, { status: "verified", correlation: UUID, errorCodes: [] });
  const output = JSON.stringify(result);
  assert.equal(output.includes(privateData), false);
  assert.equal(output.includes(BODY), false);
  assert.equal(output.includes("PRIVATE-GUID"), false);
  assert.equal(output.includes("PRIVATE-SEND-GUID"), false);
  assert.equal(output.includes("PRIVATE-ID"), false);
});

test("verification requires one exact outgoing row", async () => {
  const cases = [
    [[], "VERIFICATION_NOT_FOUND"],
    [[{ text: BODY, is_from_me: false }], "VERIFICATION_WRONG_DIRECTION"],
    [
      [
        { text: BODY, is_from_me: true },
        { text: BODY, is_from_me: true },
      ],
      "VERIFICATION_DUPLICATE",
    ],
  ];
  for (const [rows, code] of cases) {
    const runner = runnerWith({
      searchResult: { exitCode: 0, stdout: JSON.stringify(rows), stderr: "" },
    });
    const result = await smoke({ send: true, runner });
    assert.equal(result.status, "sent_unverified");
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(runner.calls.length, 2);
  }
});

test("send failure and timeout stop without verification or retry", async () => {
  for (const [sendResult, code] of [
    [{ exitCode: 1, stdout: "", stderr: "private failure" }, "SEND_FAILED"],
    [{ exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" }, "SEND_TIMEOUT"],
  ]) {
    const runner = runnerWith({ sendResult });
    const result = await smoke({ send: true, runner });
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(runner.calls.length, 1);
  }
});

test("nonzero unsafe delivery dispositions are uncertain while not_started is failed", async () => {
  for (const [sendResult, status, code] of [
    [
      { exitCode: 1, stdout: "", stderr: "delivery disposition: may_have_completed" },
      "send_outcome_unknown",
      "SEND_OUTCOME_UNCERTAIN",
    ],
    [
      { exitCode: 1, stdout: '{"disposition":"still_in_flight"}', stderr: "" },
      "send_outcome_unknown",
      "SEND_OUTCOME_UNCERTAIN",
    ],
    [
      { exitCode: 1, stdout: "", stderr: "delivery disposition: not_started" },
      "send_failed",
      "SEND_FAILED",
    ],
  ]) {
    const runner = runnerWith({ sendResult });
    const result = await smoke({ send: true, runner });
    assert.equal(result.status, status);
    assert.deepEqual(result.errorCodes, [code]);
    assert.equal(runner.calls.length, 1);
  }
});

test("explicit uncertain send result stops without verification or retry", async () => {
  for (const payload of [
    { success: true, uncertain: true },
    { success: false, may_have_completed: true },
    { status: "unknown" },
  ]) {
    const runner = runnerWith({
      sendResult: { exitCode: 0, stdout: JSON.stringify(payload), stderr: "" },
    });
    const result = await smoke({ send: true, runner });
    assert.deepEqual(result.errorCodes, ["SEND_OUTCOME_UNCERTAIN"]);
    assert.equal(runner.calls.length, 1);
  }
});

test("exit-zero send requires exact documented sent status", async () => {
  for (const stdout of [
    '{"success":true}',
    '{"status":"success"}',
    '{"status":"Sent"}',
    "not-json",
  ]) {
    const runner = runnerWith({ sendResult: { exitCode: 0, stdout, stderr: "" } });
    const result = await smoke({ send: true, runner });
    assert.equal(result.status, "send_outcome_unknown");
    assert.deepEqual(result.errorCodes, ["SEND_OUTCOME_UNCERTAIN"]);
    assert.equal(runner.calls.length, 1);
  }
});

test("private send and verification diagnostics never reach output", async () => {
  for (const options of [
    { sendResult: { exitCode: 1, stdout: "", stderr: `failed for ${RECIPIENT} ${BODY}` } },
    { searchResult: { exitCode: 1, stdout: "", stderr: `database row ${BODY} PRIVATE-GUID` } },
  ]) {
    const runner = runnerWith(options);
    const result = await smoke({ send: true, runner });
    const output = JSON.stringify(result);
    assert.equal(output.includes(RECIPIENT), false);
    assert.equal(output.includes(BODY), false);
    assert.equal(output.includes("PRIVATE-GUID"), false);
  }
});
