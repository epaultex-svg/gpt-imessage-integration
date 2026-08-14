import assert from "node:assert/strict";
import test from "node:test";
import {
  configureAgentMcp,
  parseConfigureArguments,
} from "../scripts/lib/agent-mcp.mjs";

const OPENCLAW_PATH = "/Applications/Open Claw/bin/openclaw";
const CODEX_INSPECT = ["mcp", "get", "openclaw", "--json"];
const CLAUDE_INSPECT = ["mcp", "get", "openclaw"];
const CODEX_ADD = [
  "mcp",
  "add",
  "openclaw",
  "--",
  OPENCLAW_PATH,
  "mcp",
  "serve",
  "--claude-channel-mode",
  "off",
];
const CLAUDE_ADD = [
  "mcp",
  "add",
  "--scope",
  "user",
  "openclaw",
  "--",
  OPENCLAW_PATH,
  "mcp",
  "serve",
  "--claude-channel-mode",
  "on",
];

const ABSENT = {
  codex: {
    exitCode: 1,
    stdout: "",
    stderr: "Error: No MCP server named 'openclaw' found.",
  },
  claude: {
    exitCode: 1,
    stdout: 'No MCP server named "openclaw". Configured servers: something-else',
    stderr: "",
  },
};

function exactCodex(path = OPENCLAW_PATH) {
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      name: "openclaw",
      enabled: true,
      transport: {
        type: "stdio",
        command: path,
        args: ["mcp", "serve", "--claude-channel-mode", "off"],
        env: null,
      },
    }),
    stderr: "",
  };
}

function exactClaude(path = OPENCLAW_PATH) {
  return {
    exitCode: 0,
    stdout: [
      "openclaw:",
      "  Scope: User config",
      "  Type: stdio",
      `  Command: ${path}`,
      "  Args: mcp serve --claude-channel-mode on",
      "  Environment:",
    ].join("\n"),
    stderr: "",
  };
}

function fakeRunner({ codex = ABSENT.codex, claude = ABSENT.claude, add = {} } = {}) {
  const calls = [];
  return {
    calls,
    async resolve(command) {
      assert.equal(command, "openclaw");
      return OPENCLAW_PATH;
    },
    async run(command, args) {
      calls.push({ command, args: [...args] });
      if (command === "codex" && args[0] === "mcp" && args[1] === "get") return codex;
      if (command === "claude" && args[0] === "mcp" && args[1] === "get") return claude;
      return add[command] ?? { exitCode: 0, stdout: "added", stderr: "" };
    },
  };
}

test("argument parser makes dry-run default and accepts only --apply", () => {
  assert.deepEqual(parseConfigureArguments([]), { valid: true, apply: false });
  assert.deepEqual(parseConfigureArguments(["--apply"]), { valid: true, apply: true });
  assert.deepEqual(parseConfigureArguments(["--force"]), { valid: false, apply: false });
  assert.deepEqual(parseConfigureArguments(["--apply", "extra"]), { valid: false, apply: false });
});

test("dry run plans missing agents without invoking add", async () => {
  const runner = fakeRunner();
  const result = await configureAgentMcp({ runner });

  assert.equal(result.status, "changes_planned");
  assert.deepEqual(result.agents, {
    codex: { status: "add_planned" },
    claude: { status: "add_planned" },
  });
  assert.deepEqual(runner.calls, [
    { command: "codex", args: CODEX_INSPECT },
    { command: "claude", args: CLAUDE_INSPECT },
  ]);
});

test("apply uses exact argv and preserves executable paths containing spaces", async () => {
  const runner = fakeRunner();
  const result = await configureAgentMcp({ apply: true, runner });

  assert.equal(result.status, "configured");
  assert.deepEqual(result.agents, {
    codex: { status: "added" },
    claude: { status: "added" },
  });
  assert.deepEqual(runner.calls.slice(2), [
    { command: "codex", args: CODEX_ADD },
    { command: "claude", args: CLAUDE_ADD },
  ]);
  assert.equal(runner.calls[2].args.includes(`"${OPENCLAW_PATH}"`), false);
});

test("exact existing registrations are no-ops", async () => {
  const runner = fakeRunner({ codex: exactCodex(), claude: exactClaude() });
  const result = await configureAgentMcp({ apply: true, runner });

  assert.equal(result.status, "ready");
  assert.deepEqual(result.agents, {
    codex: { status: "noop" },
    claude: { status: "noop" },
  });
  assert.equal(runner.calls.length, 2);
});

test("existing conflict fails closed and prevents all adds", async () => {
  const conflict = exactCodex("/tmp/different-openclaw");
  const runner = fakeRunner({ codex: conflict });
  const result = await configureAgentMcp({ apply: true, runner });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.agents, {
    codex: { status: "conflict" },
    claude: { status: "not_applied" },
  });
  assert.deepEqual(result.errorCodes, ["CODEX_CONFIGURATION_CONFLICT"]);
  assert.equal(runner.calls.length, 2);
});

test("inspection diagnostics and conflicting config never reach output", async () => {
  const secret = "TOP_SECRET_ENV_VALUE";
  const privatePath = "/Users/private person/bin/openclaw";
  const runner = fakeRunner({
    codex: {
      exitCode: 0,
      stdout: JSON.stringify({
        transport: {
          type: "stdio",
          command: privatePath,
          args: ["mcp", "serve"],
          env: { API_TOKEN: secret },
        },
      }),
      stderr: `diagnostic ${secret}`,
    },
    claude: {
      exitCode: 2,
      stdout: "",
      stderr: `failed to inspect ${privatePath} token=${secret}`,
    },
  });
  const result = await configureAgentMcp({ runner });
  const output = JSON.stringify(result);

  assert.ok(result.errorCodes.includes("CODEX_CONFIGURATION_CONFLICT"));
  assert.ok(result.errorCodes.includes("CLAUDE_INSPECTION_FAILED"));
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(privatePath), false);
  assert.equal(output.includes("API_TOKEN"), false);
});

test("partial add failure reports completed work and stops remaining changes", async () => {
  const runner = fakeRunner({
    add: {
      codex: { exitCode: 0, stdout: "added", stderr: "" },
      claude: { exitCode: 1, stdout: "", stderr: "private failure detail" },
    },
  });
  const result = await configureAgentMcp({ apply: true, runner });

  assert.equal(result.status, "blocked");
  assert.deepEqual(result.agents, {
    codex: { status: "added" },
    claude: { status: "add_failed" },
  });
  assert.deepEqual(result.errorCodes, ["CLAUDE_ADD_FAILED"]);
  assert.equal(JSON.stringify(result).includes("private failure detail"), false);
});
