import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseTargetResolverArguments,
  resolveTarget,
} from "../scripts/lib/target-resolver.mjs";

const IMSG = "/opt/tools/imsg";
const DATABASE = "/private/Messages/chat.db";
const NAME = "Test Recipient";
const HANDLE = "+14155550101";
const UUID = "123e4567-e89b-42d3-a456-426614174000";
const ENV = {
  IMSG_CLI_PATH: IMSG,
  IMESSAGE_DB_PATH: DATABASE,
  IMESSAGE_TARGET_CONTACT_NAME: NAME,
};
const CHAT = {
  identifier: HANDLE,
  display_name: NAME,
  contact_name: NAME,
  is_group: false,
  service: "iMessage",
};
const ARGS = ["chats", "--limit", "250", "--db", DATABASE, "--json"];

function command(exitCode = 0, stdout = JSON.stringify([CHAT]), stderr = "") {
  return { exitCode, stdout, stderr };
}

function fakeRunner(response = command()) {
  const calls = [];
  return {
    calls,
    async run(executable, args) {
      calls.push({ executable, args: [...args] });
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

test("argument parser defaults read-only and accepts one safe output option", () => {
  assert.deepEqual(parseTargetResolverArguments([]), {
    valid: true,
    write: false,
    outputPath: ".local/imessage-test-target.env",
  });
  assert.deepEqual(parseTargetResolverArguments(["--write"]), {
    valid: true,
    write: true,
    outputPath: ".local/imessage-test-target.env",
  });
  assert.deepEqual(parseTargetResolverArguments(["--output", ".local/nested/test.env", "--write"]), {
    valid: true,
    write: true,
    outputPath: ".local/nested/test.env",
  });
  for (const args of [["--apply"], ["--write", "--write"], ["--output"], ["--output", "a", "--output", "b"]]) {
    assert.equal(parseTargetResolverArguments(args).valid, false);
  }
});

test("invalid inputs and unsafe output paths fail before invoking imsg", async () => {
  const cases = [
    [{ ...ENV, IMSG_CLI_PATH: "imsg" }, undefined, "IMSG_CLI_PATH_INVALID"],
    [{ ...ENV, IMESSAGE_DB_PATH: "relative/chat.db" }, undefined, "IMESSAGE_DB_PATH_INVALID"],
    [{ ...ENV, IMESSAGE_TARGET_CONTACT_NAME: "<contact-name>" }, undefined, "TARGET_CONTACT_NAME_INVALID"],
    [ENV, "/tmp/target.env", "TARGET_OUTPUT_PATH_INVALID"],
    [ENV, ".local/../target.env", "TARGET_OUTPUT_PATH_INVALID"],
    [ENV, ".local/target name.env", "TARGET_OUTPUT_PATH_INVALID"],
  ];
  for (const [env, outputPath, code] of cases) {
    const runner = fakeRunner();
    const resolution = await resolveTarget({ env, outputPath, runner });
    assert.deepEqual(resolution.errorCodes, [code]);
    assert.deepEqual(runner.calls, []);
  }
});

test("dry run normalizes exact name and iMessage service and uses pinned read-only argv", async () => {
  const row = {
    ...CHAT,
    display_name: "  TEST\u00a0recipient  ",
    contact_name: null,
    service: "IMESSAGE",
  };
  const runner = fakeRunner(command(0, JSON.stringify({ chats: [row] })));
  const resolution = await resolveTarget({ env: ENV, runner });
  assert.deepEqual(resolution, { status: "dry_run", errorCodes: [], matchCount: 1 });
  assert.deepEqual(runner.calls, [{ executable: IMSG, args: ARGS }]);
});

test("JSON and NDJSON duplicate rows dedupe only by exact identifier", async () => {
  const duplicate = { ...CHAT, name: NAME, display_name: null };
  const sameRunner = fakeRunner(command(0, `${JSON.stringify(CHAT)}\n${JSON.stringify(duplicate)}\n`));
  assert.deepEqual(await resolveTarget({ env: ENV, runner: sameRunner }), {
    status: "dry_run", errorCodes: [], matchCount: 1,
  });

  const distinctRunner = fakeRunner(command(0, JSON.stringify([
    CHAT,
    { ...CHAT, identifier: "+14155550102" },
  ])));
  assert.deepEqual(await resolveTarget({ env: ENV, runner: distinctRunner }), {
    status: "blocked", errorCodes: ["TARGET_AMBIGUOUS"], matchCount: 2,
  });
});

test("group, SMS, invalid identifiers, absent targets, and malformed payloads fail closed", async () => {
  const cases = [
    [[{ ...CHAT, is_group: true }], "TARGET_GROUP_REJECTED", 1],
    [[{ ...CHAT, service: "SMS" }], "TARGET_SERVICE_REJECTED", 1],
    [[{ ...CHAT, identifier: "chat123" }], "TARGET_IDENTIFIER_INVALID", 1],
    [[{ ...CHAT, display_name: "Someone Else", contact_name: "Someone Else" }], "TARGET_NOT_FOUND", 0],
  ];
  for (const [rows, code, matchCount] of cases) {
    const resolution = await resolveTarget({ env: ENV, runner: fakeRunner(command(0, JSON.stringify(rows))) });
    assert.deepEqual(resolution, { status: "blocked", errorCodes: [code], matchCount });
  }
  for (const stdout of ["", "private malformed payload", JSON.stringify([null])]) {
    const resolution = await resolveTarget({ env: ENV, runner: fakeRunner(command(0, stdout)) });
    assert.deepEqual(resolution.errorCodes, ["IMSG_CHATS_MALFORMED"]);
  }
});

test("TCC denial, timeout, command failure, and thrown runner use fixed codes", async () => {
  const cases = [
    [command(1, "", `Operation not permitted: ${DATABASE} ${NAME}`), "FULL_DISK_ACCESS_REQUIRED"],
    [{ exitCode: null, errorCode: "ETIMEDOUT", stdout: "", stderr: "" }, "IMSG_CHATS_TIMEOUT"],
    [command(1, "private rows", "private failure"), "IMSG_CHATS_FAILED"],
    [new Error(`private ${NAME} ${HANDLE}`), "IMSG_CHATS_FAILED"],
  ];
  for (const [response, code] of cases) {
    const resolution = await resolveTarget({ env: ENV, runner: fakeRunner(response) });
    assert.deepEqual(resolution.errorCodes, [code]);
    const serialized = JSON.stringify(resolution);
    for (const privateValue of [NAME, HANDLE, DATABASE]) assert.equal(serialized.includes(privateValue), false);
  }
});

test("explicit write creates mode-0600 file atomically and identical rerun is idempotent", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "imessage-target-"));
  try {
    const outputPath = ".local/nested/target.env";
    const options = { write: true, outputPath, cwd, env: ENV, uuidFactory: () => UUID, runner: fakeRunner() };
    assert.deepEqual(await resolveTarget(options), { status: "written", errorCodes: [], matchCount: 1 });
    const target = path.join(cwd, outputPath);
    const expected = [
      `export PAUL_IMESSAGE_HANDLE='${HANDLE}'`,
      `export IMESSAGE_TEST_RECIPIENT='${HANDLE}'`,
      `export IMESSAGE_TEST_ALLOWLIST='${HANDLE}'`,
      `export IMESSAGE_E2E_RECIPIENT='${HANDLE}'`,
      `export IMESSAGE_E2E_ALLOWLIST='${HANDLE}'`,
      "",
    ].join("\n");
    assert.equal(await readFile(target, "utf8"), expected);
    assert.equal((await stat(target)).mode & 0o777, 0o600);
    assert.deepEqual(await resolveTarget({ ...options, runner: fakeRunner() }), {
      status: "unchanged", errorCodes: [], matchCount: 1,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("existing different file conflicts without overwrite", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "imessage-target-conflict-"));
  try {
    const target = path.join(cwd, ".local/imessage-test-target.env");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "PRIVATE EXISTING CONTENT\n", { mode: 0o600 });
    const resolution = await resolveTarget({ write: true, cwd, env: ENV, runner: fakeRunner() });
    assert.deepEqual(resolution, { status: "blocked", errorCodes: ["TARGET_FILE_CONFLICT"], matchCount: 1 });
    assert.equal(await readFile(target, "utf8"), "PRIVATE EXISTING CONTENT\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("generated exports use safe POSIX quoting and result remains private", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "imessage-target-quote-"));
  const handle = "o'operator@example.test";
  try {
    const runner = fakeRunner(command(0, JSON.stringify([{ ...CHAT, identifier: handle }])));
    const resolution = await resolveTarget({ write: true, cwd, env: ENV, runner });
    assert.deepEqual(resolution, { status: "written", errorCodes: [], matchCount: 1 });
    const contents = await readFile(path.join(cwd, ".local/imessage-test-target.env"), "utf8");
    assert.match(contents, /o'\\''operator@example\.test/);
    assert.equal(JSON.stringify(resolution).includes(handle), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("symlinked parents and invalid temporary tokens cause no target write", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "imessage-target-safe-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "imessage-target-outside-"));
  try {
    await symlink(outside, path.join(cwd, ".local"));
    const symlinkResult = await resolveTarget({ write: true, cwd, env: ENV, runner: fakeRunner() });
    assert.deepEqual(symlinkResult, {
      status: "blocked", errorCodes: ["TARGET_FILE_UNSAFE"], matchCount: 1,
    });
    await assert.rejects(readFile(path.join(outside, "imessage-test-target.env"), "utf8"), { code: "ENOENT" });

    await rm(path.join(cwd, ".local"));
    const invalidUuid = await resolveTarget({
      write: true,
      cwd,
      env: ENV,
      runner: fakeRunner(),
      uuidFactory: () => "../../escape",
    });
    assert.deepEqual(invalidUuid, {
      status: "blocked", errorCodes: ["TARGET_FILE_UNSAFE"], matchCount: 1,
    });
    await assert.rejects(stat(path.join(cwd, ".local")), { code: "ENOENT" });

    await mkdir(path.join(cwd, ".local"));
    await symlink(outside, path.join(cwd, ".local/nested"));
    const nestedResult = await resolveTarget({
      write: true,
      outputPath: ".local/nested/target.env",
      cwd,
      env: ENV,
      runner: fakeRunner(),
    });
    assert.deepEqual(nestedResult.errorCodes, ["TARGET_FILE_UNSAFE"]);
    await assert.rejects(readFile(path.join(outside, "target.env"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
