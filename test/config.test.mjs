import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildConfig, validateConfig } from "../scripts/lib/config.mjs";
import { applyManagedPatch, mergeManagedPatch } from "../scripts/lib/patch.mjs";

const SAFE_ENV = {
  PAUL_IMESSAGE_HANDLE: "+14155550101",
  IMESSAGE_EXTRA_ALLOW_FROM: "operator@real-domain.test",
  IMSG_CLI_PATH: "/opt/homebrew/bin/imsg",
  IMESSAGE_DB_PATH: "/Users/operator/Library/Messages/chat.db",
};

function safeConfig() {
  return structuredClone(buildConfig(SAFE_ENV));
}

test("generator creates strict local-only allowlisted configuration", () => {
  assert.deepEqual(safeConfig(), {
    gateway: { mode: "local", bind: "loopback" },
    channels: {
      imessage: {
        enabled: true,
        cliPath: "/opt/homebrew/bin/imsg",
        dbPath: "/Users/operator/Library/Messages/chat.db",
        dmPolicy: "allowlist",
        allowFrom: ["+14155550101", "operator@real-domain.test"],
        groupPolicy: "disabled",
        groupAllowFrom: [],
        configWrites: false,
      },
    },
  });
});

test("generator requires Paul's private handle and local paths", () => {
  assert.throws(
    () => buildConfig({}),
    /PAUL_IMESSAGE_HANDLE, IMSG_CLI_PATH, IMESSAGE_DB_PATH/,
  );
});

test("validator rejects empty allowlist", () => {
  const config = safeConfig();
  config.channels.imessage.allowFrom = [];
  assert.match(validateConfig(config).join("\n"), /at least one exact handle/);
});

test("validator rejects wildcard and non-handle allowlist entries", () => {
  for (const handle of ["*", "+1415*", "chat_id:123", "any sender"]) {
    const config = safeConfig();
    config.channels.imessage.allowFrom = [handle];
    assert.match(validateConfig(config).join("\n"), /invalid exact allowFrom handle/);
  }
});

test("validator rejects enabled or allowlisted groups", () => {
  const enabled = safeConfig();
  enabled.channels.imessage.groupPolicy = "allowlist";
  assert.match(validateConfig(enabled).join("\n"), /groupPolicy must be "disabled"/);

  const senderAllowed = safeConfig();
  senderAllowed.channels.imessage.groupAllowFrom = ["+14155550101"];
  assert.match(validateConfig(senderAllowed).join("\n"), /groupAllowFrom must be an empty array/);
});

test("validator rejects relative paths", () => {
  for (const key of ["cliPath", "dbPath"]) {
    const config = safeConfig();
    config.channels.imessage[key] = `relative/${key}`;
    assert.match(validateConfig(config).join("\n"), new RegExp(`${key} must be an absolute path`));
  }
});

test("validator rejects placeholders in live configuration", () => {
  for (const value of ["<paul-handle>", "${PAUL_HANDLE}", "+15555550123", "paul@example.com"]) {
    const config = safeConfig();
    config.channels.imessage.allowFrom = [value];
    assert.match(validateConfig(config).join("\n"), /placeholder value is forbidden/);
  }
});

test("validator rejects config writes and non-loopback gateway exposure", () => {
  const writes = safeConfig();
  writes.channels.imessage.configWrites = true;
  assert.match(validateConfig(writes).join("\n"), /configWrites must be false/);

  const exposed = safeConfig();
  exposed.gateway.bind = "lan";
  assert.match(validateConfig(exposed).join("\n"), /gateway.bind must be "loopback"/);
});

test("validator rejects secret-bearing keys and secret-like values", () => {
  const secretKey = safeConfig();
  secretKey.gateway.token = "not-even-a-real-token";
  assert.match(validateConfig(secretKey).join("\n"), /secret-bearing key is forbidden: gateway.token/);

  const secretValue = safeConfig();
  secretValue.channels.imessage.allowFrom = ["sk-abcdefghijklmnopqrstuvwxyz123456"];
  assert.match(validateConfig(secretValue).join("\n"), /secret-like value is forbidden/);
});

test("validator rejects unknown fields so placeholders cannot masquerade as live config", () => {
  const config = safeConfig();
  config.channels.imessage.model = "replace-me";
  const errors = validateConfig(config).join("\n");
  assert.match(errors, /must contain exactly/);
  assert.match(errors, /placeholder value is forbidden/);
});

test("managed merge preserves unrelated OpenClaw settings", () => {
  const existing = {
    gateway: { port: 18789, auth: { mode: "token" } },
    channels: {
      slack: { enabled: false },
      imessage: { dmPolicy: "open", allowFrom: ["*"] },
    },
    agents: { defaults: { workspace: "/Users/operator/workspace" } },
  };

  const merged = mergeManagedPatch(existing, safeConfig());
  assert.deepEqual(merged.agents, existing.agents);
  assert.deepEqual(merged.channels.slack, existing.channels.slack);
  assert.equal(merged.gateway.port, 18789);
  assert.deepEqual(merged.gateway.auth, { mode: "token" });
  assert.deepEqual(merged.channels.imessage, safeConfig().channels.imessage);
  assert.notEqual(merged.channels.imessage, existing.channels.imessage);
});

test("file apply creates exact backup before atomic managed merge", async () => {
  await mkdir(path.resolve(".local"), { recursive: true });
  const directory = await mkdtemp(path.resolve(".local/merge-test-"));
  try {
    const configPath = path.join(directory, "openclaw.json");
    const patchPath = path.join(directory, "patch.json");
    const existing = {
      gateway: { port: 18789 },
      channels: { slack: { enabled: false } },
      agents: { defaults: { workspace: "/Users/operator/workspace" } },
    };
    await writeFile(configPath, `${JSON.stringify(existing)}\n`, { mode: 0o600 });
    await writeFile(patchPath, `${JSON.stringify(safeConfig())}\n`, { mode: 0o600 });

    const result = await applyManagedPatch(configPath, patchPath, new Date("2026-08-13T12:00:00.000Z"));
    assert.deepEqual(JSON.parse(await readFile(result.backupPath, "utf8")), existing);

    const applied = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(applied.agents, existing.agents);
    assert.deepEqual(applied.channels.slack, existing.channels.slack);
    assert.deepEqual(applied.channels.imessage, safeConfig().channels.imessage);
    assert.equal(applied.gateway.port, 18789);

    const names = await readdir(directory);
    assert.equal(names.filter((name) => name.includes(".backup.")).length, 1);
    assert.equal(names.filter((name) => name.includes(".tmp.")).length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
