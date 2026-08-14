import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runPreflight } from "../scripts/lib/preflight.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VERSIONS_PATH = path.join(ROOT, "versions.json");

const HEALTHY_OUTPUTS = new Map([
  ["openclaw --version", { exitCode: 0, stdout: "OpenClaw 2026.6.5 (build)\n", stderr: "" }],
  ["imsg --version", { exitCode: 0, stdout: "0.14.1\n", stderr: "" }],
  ["csrutil status", { exitCode: 0, stdout: "System Integrity Protection status: enabled.\n", stderr: "" }],
  [
    "imsg status --json",
    {
      exitCode: 0,
      stdout: JSON.stringify({ basic_features: true, advanced_features: false }),
      stderr: "",
    },
  ],
  [
    "imsg chats --limit 1 --json",
    {
      exitCode: 0,
      stdout: JSON.stringify({
        chat_id: 42,
        identifier: "+15555550123",
        display_name: "PRIVATE CHAT NAME",
        latest_message: "PRIVATE MESSAGE CONTENT",
      }),
      stderr: "",
    },
  ],
]);

function fakeRunner(overrides = {}) {
  const outputs = new Map(HEALTHY_OUTPUTS);
  for (const [command, result] of Object.entries(overrides)) outputs.set(command, result);
  return {
    async run(command, args) {
      const key = [command, ...args].join(" ");
      return outputs.get(key) ?? { exitCode: null, stdout: "", stderr: "", errorCode: "ENOENT" };
    },
  };
}

function installation(overrides = {}) {
  return async () => ({
    found: true,
    packageVersion: "2026.6.5",
    engineRange: ">=22.19.0",
    pluginExists: true,
    ...overrides,
  });
}

async function preflight({ commandOverrides, installationOverrides, ...options } = {}) {
  return runPreflight({
    runner: fakeRunner(commandOverrides),
    platform: "darwin",
    nodeVersion: "v24.11.0",
    versionsPath: VERSIONS_PATH,
    installationProbe: installation(installationOverrides),
    ...options,
  });
}

test("healthy transport reports only fixed status fields and chat count", async () => {
  const result = await preflight();
  assert.equal(result.status, "ready");
  assert.deepEqual(result.errorCodes, []);
  assert.deepEqual(result.checks.messageDatabase, { status: "pass", count: 1 });

  const serialized = JSON.stringify(result);
  for (const privateValue of [
    "+15555550123",
    "PRIVATE CHAT NAME",
    "PRIVATE MESSAGE CONTENT",
    "chat_id",
    "identifier",
    "latest_message",
  ]) {
    assert.equal(serialized.includes(privateValue), false);
  }
});

test("wrong pinned versions fail without reporting observed versions", async () => {
  const result = await preflight({
    commandOverrides: {
      "openclaw --version": { exitCode: 0, stdout: "OpenClaw 2026.6.4\n", stderr: "" },
      "imsg --version": { exitCode: 0, stdout: "0.14.0\n", stderr: "" },
    },
    installationOverrides: { packageVersion: "2026.6.4" },
  });

  assert.equal(result.status, "blocked");
  assert.ok(result.errorCodes.includes("OPENCLAW_VERSION_MISMATCH"));
  assert.ok(result.errorCodes.includes("IMSG_VERSION_MISMATCH"));
  assert.equal(JSON.stringify(result).includes("2026.6.4"), false);
  assert.equal(JSON.stringify(result).includes("0.14.0"), false);
});

test("Node must satisfy installed OpenClaw engine", async () => {
  const result = await preflight({ nodeVersion: "v22.18.0" });
  assert.equal(result.checks.node.status, "fail");
  assert.ok(result.errorCodes.includes("NODE_VERSION_UNSUPPORTED"));
});

test("SIP disabled is actionable and blocks transport", async () => {
  const result = await preflight({
    commandOverrides: {
      "csrutil status": {
        exitCode: 0,
        stdout: "System Integrity Protection status: disabled.\n",
        stderr: "",
      },
    },
  });
  assert.equal(result.checks.sip.status, "fail");
  assert.ok(result.errorCodes.includes("SIP_DISABLED"));
});

test("malformed status and chats output are rejected without echo", async () => {
  const privateGarbage = "not-json +15555550123 PRIVATE MESSAGE CONTENT";
  const result = await preflight({
    commandOverrides: {
      "imsg status --json": { exitCode: 0, stdout: privateGarbage, stderr: "" },
      "imsg chats --limit 1 --json": { exitCode: 0, stdout: privateGarbage, stderr: "" },
    },
  });
  assert.ok(result.errorCodes.includes("IMSG_STATUS_MALFORMED"));
  assert.ok(result.errorCodes.includes("IMESSAGE_CHATS_OUTPUT_MALFORMED"));
  assert.equal(JSON.stringify(result).includes(privateGarbage), false);
});

test("macOS TCC denial maps to Full Disk Access without leaking diagnostics", async () => {
  const diagnostic = "authorization denied opening /Users/person/Library/Messages/chat.db";
  const result = await preflight({
    commandOverrides: {
      "imsg chats --limit 1 --json": { exitCode: 1, stdout: "", stderr: diagnostic },
    },
  });
  assert.deepEqual(result.checks.messageDatabase, { status: "fail" });
  assert.ok(result.errorCodes.includes("FULL_DISK_ACCESS_REQUIRED"));
  assert.equal(JSON.stringify(result).includes("/Users/person"), false);
});

test("missing bundled iMessage plugin blocks readiness", async () => {
  const result = await preflight({ installationOverrides: { pluginExists: false } });
  assert.equal(result.checks.imessagePlugin.status, "fail");
  assert.ok(result.errorCodes.includes("OPENCLAW_IMESSAGE_PLUGIN_NOT_FOUND"));
});
