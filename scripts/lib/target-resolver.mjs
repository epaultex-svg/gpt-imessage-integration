import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT_PATH = ".local/imessage-test-target.env";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const PLACEHOLDER_PATTERN = /<[^>]+>|\$\{[^}]+\}|(?:^|\/)absolute\/path(?:\/|$)|\b(?:change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ])/i;

function result(status, errorCodes = [], matchCount = 0) {
  return { status, errorCodes, matchCount };
}

function exactAbsolutePath(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    path.isAbsolute(value) &&
    !PLACEHOLDER_PATTERN.test(value);
}

function exactHandle(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    !PLACEHOLDER_PATTERN.test(value) &&
    (E164_PATTERN.test(value) || EMAIL_PATTERN.test(value));
}

function normalizeName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
  return normalized || null;
}

function validContactName(value) {
  return typeof value === "string" &&
    value === value.trim() &&
    value.length <= 200 &&
    !/[\u0000-\u001f\u007f]/u.test(value) &&
    !PLACEHOLDER_PATTERN.test(value) &&
    normalizeName(value) !== null;
}

function safeOutputPath(value, cwd) {
  if (typeof value !== "string" || value === "" || path.isAbsolute(value) || value.includes("\\")) {
    return null;
  }
  const segments = value.split("/");
  if (
    segments[0] !== ".local" ||
    segments.length < 2 ||
    segments.some((segment) => !segment || segment === "." || segment === ".." || !/^[A-Za-z0-9._-]+$/.test(segment))
  ) {
    return null;
  }
  const root = path.resolve(cwd, ".local");
  const resolved = path.resolve(cwd, ...segments);
  return resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function collectRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value.chats)) return value.chats;
  return [value];
}

function parseRows(output) {
  const trimmed = String(output ?? "").trim();
  if (!trimmed) return null;
  const whole = parseJson(trimmed);
  if (whole !== null) return collectRows(whole);
  const rows = [];
  for (const line of trimmed.split(/\r?\n/).filter(Boolean)) {
    const parsed = parseJson(line);
    const items = collectRows(parsed);
    if (!items) return null;
    rows.push(...items);
  }
  return rows;
}

function chatNames(chat) {
  return [
    chat.contact,
    chat.contact_name,
    chat.contactName,
    chat.display,
    chat.display_name,
    chat.displayName,
    chat.name,
  ].filter((value) => typeof value === "string");
}

function chatIdentifier(chat) {
  const values = [chat.identifier, chat.chat_identifier, chat.chatIdentifier]
    .filter((value) => typeof value === "string");
  const unique = [...new Set(values)];
  return unique.length === 1 ? unique[0] : null;
}

function authorizationDenied(commandResult) {
  const diagnostic = `${commandResult?.stdout ?? ""}\n${commandResult?.stderr ?? ""}`;
  return /full disk access|operation not permitted|permission denied|not authori[sz]ed|authorization denied|\btcc\b/i.test(
    diagnostic,
  );
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function targetFile(handle) {
  const quoted = shellQuote(handle);
  return [
    `export PAUL_IMESSAGE_HANDLE=${quoted}`,
    `export IMESSAGE_TEST_RECIPIENT=${quoted}`,
    `export IMESSAGE_TEST_ALLOWLIST=${quoted}`,
    `export IMESSAGE_E2E_RECIPIENT=${quoted}`,
    `export IMESSAGE_E2E_ALLOWLIST=${quoted}`,
    "",
  ].join("\n");
}

async function existingFile(target) {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return { unsafe: true };
    return { content: await readFile(target, "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeParents(cwd, target) {
  const relative = path.relative(cwd, path.dirname(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = cwd;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) return false;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (mkdirError?.code !== "EEXIST") throw mkdirError;
      }
      const created = await lstat(current);
      if (!created.isDirectory() || created.isSymbolicLink()) return false;
    }
  }
  return true;
}

async function writeAtomically(target, content, uuidFactory, cwd) {
  let token;
  try {
    token = uuidFactory();
  } catch {
    return "unsafe";
  }
  if (typeof token !== "string" || !UUID_PATTERN.test(token)) return "unsafe";
  if (!(await ensureSafeParents(cwd, target))) return "unsafe";
  const existing = await existingFile(target);
  if (existing?.unsafe) return "unsafe";
  if (existing) {
    if (existing.content !== content) return "conflict";
    await chmod(target, 0o600);
    return "unchanged";
  }
  const temporary = `${target}.tmp-${token}`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    try {
      await link(temporary, target);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const raced = await existingFile(target);
      if (raced?.content === content) {
        await chmod(target, 0o600);
        return "unchanged";
      }
      return raced?.unsafe ? "unsafe" : "conflict";
    }
    await chmod(target, 0o600);
    return "written";
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

export function createCommandRunner({ timeoutMs = 20_000, env = process.env } = {}) {
  return {
    async run(command, args) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn(command, args, { env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          finish({ exitCode: null, stdout: "", stderr: "", errorCode: "ETIMEDOUT" });
        }, timeoutMs);
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("error", (error) => finish({ exitCode: null, stdout: "", stderr: "", errorCode: error.code }));
        child.on("close", (exitCode) => finish({ exitCode, stdout, stderr }));
      });
    },
  };
}

export async function resolveTarget({
  write = false,
  outputPath = DEFAULT_OUTPUT_PATH,
  env = process.env,
  cwd = process.cwd(),
  runner = createCommandRunner(),
  uuidFactory = randomUUID,
} = {}) {
  const imsgPath = env.IMSG_CLI_PATH;
  const databasePath = env.IMESSAGE_DB_PATH;
  const contactName = env.IMESSAGE_TARGET_CONTACT_NAME;
  const target = safeOutputPath(outputPath, cwd);
  if (!exactAbsolutePath(imsgPath)) return result("blocked", ["IMSG_CLI_PATH_INVALID"]);
  if (!exactAbsolutePath(databasePath)) return result("blocked", ["IMESSAGE_DB_PATH_INVALID"]);
  if (!validContactName(contactName)) return result("blocked", ["TARGET_CONTACT_NAME_INVALID"]);
  if (!target) return result("blocked", ["TARGET_OUTPUT_PATH_INVALID"]);

  let commandResult;
  try {
    commandResult = await runner.run(imsgPath, [
      "chats", "--limit", "250", "--db", databasePath, "--json",
    ]);
  } catch {
    return result("blocked", ["IMSG_CHATS_FAILED"]);
  }
  if (commandResult?.errorCode === "ETIMEDOUT" || commandResult?.timedOut === true) {
    return result("blocked", ["IMSG_CHATS_TIMEOUT"]);
  }
  if (!commandResult || commandResult.exitCode !== 0) {
    return authorizationDenied(commandResult)
      ? result("blocked", ["FULL_DISK_ACCESS_REQUIRED"])
      : result("blocked", ["IMSG_CHATS_FAILED"]);
  }
  const rows = parseRows(commandResult.stdout);
  if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    return result("blocked", ["IMSG_CHATS_MALFORMED"]);
  }

  const wanted = normalizeName(contactName);
  const matches = rows.filter((chat) => chatNames(chat).some((name) => normalizeName(name) === wanted));
  if (matches.length === 0) return result("blocked", ["TARGET_NOT_FOUND"], 0);
  const direct = matches.filter((chat) => chat.is_group === false);
  if (direct.length === 0) return result("blocked", ["TARGET_GROUP_REJECTED"], matches.length);
  const imessage = direct.filter(
    (chat) => typeof chat.service === "string" && chat.service.toLocaleLowerCase("en-US") === "imessage",
  );
  if (imessage.length === 0) return result("blocked", ["TARGET_SERVICE_REJECTED"], direct.length);
  const identifiers = imessage.map(chatIdentifier);
  if (identifiers.some((identifier) => !exactHandle(identifier))) {
    return result("blocked", ["TARGET_IDENTIFIER_INVALID"], imessage.length);
  }
  const uniqueIdentifiers = [...new Set(identifiers)];
  if (uniqueIdentifiers.length > 1) {
    return result("blocked", ["TARGET_AMBIGUOUS"], uniqueIdentifiers.length);
  }
  const identifier = uniqueIdentifiers[0];
  if (!write) return result("dry_run", [], 1);

  let writeStatus;
  try {
    writeStatus = await writeAtomically(target, targetFile(identifier), uuidFactory, cwd);
  } catch {
    return result("blocked", ["TARGET_FILE_WRITE_FAILED"], 1);
  }
  if (writeStatus === "conflict") return result("blocked", ["TARGET_FILE_CONFLICT"], 1);
  if (writeStatus === "unsafe") return result("blocked", ["TARGET_FILE_UNSAFE"], 1);
  return result(writeStatus, [], 1);
}

export function parseTargetResolverArguments(args) {
  let write = false;
  let outputPath = DEFAULT_OUTPUT_PATH;
  let outputSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--write" && !write) {
      write = true;
    } else if (argument === "--output" && !outputSeen && index + 1 < args.length) {
      outputSeen = true;
      outputPath = args[index + 1];
      index += 1;
    } else {
      return { valid: false, write: false, outputPath: DEFAULT_OUTPUT_PATH };
    }
  }
  return { valid: true, write, outputPath };
}

export function invalidArgumentsResult() {
  return result("blocked", ["ARGUMENTS_INVALID"]);
}
