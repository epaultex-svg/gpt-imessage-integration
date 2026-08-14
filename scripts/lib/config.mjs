import path from "node:path";

const EXACT_HANDLE_PATTERNS = [
  /^\+[1-9]\d{7,14}$/,
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
];

const PLACEHOLDER_PATTERNS = [
  /<[^>]+>/,
  /\$\{[^}]+\}/,
  /\b(?:change[-_ ]?me|replace[-_ ]?me|placeholder|your[-_ ])/i,
  /@example\.(?:com|net|org)$/i,
  /^\+1555\d{7}$/,
];

const SECRET_KEY_PATTERN = /(?:api[-_]?key|token|password|passwd|secret|private[-_]?key|credential)/i;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{16,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const EXPECTED_TOP_LEVEL_KEYS = ["channels", "gateway"];
const EXPECTED_GATEWAY_KEYS = ["bind", "mode"];
const EXPECTED_CHANNEL_KEYS = ["imessage"];
const EXPECTED_IMESSAGE_KEYS = [
  "allowFrom",
  "cliPath",
  "configWrites",
  "dbPath",
  "dmPolicy",
  "enabled",
  "groupAllowFrom",
  "groupPolicy",
];

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function walk(value, visit, keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemPath = [...keyPath, String(index)];
      visit(String(index), item, itemPath);
      walk(item, visit, itemPath);
    });
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    visit(key, child, [...keyPath, key]);
    walk(child, visit, [...keyPath, key]);
  }
}

export function isExactHandle(value) {
  return typeof value === "string" &&
    !/[\s*?\[\]]/.test(value) &&
    EXACT_HANDLE_PATTERNS.some((pattern) => pattern.test(value));
}

export function validateConfig(config) {
  const errors = [];

  if (!sameKeys(config, EXPECTED_TOP_LEVEL_KEYS)) {
    errors.push("config must contain only top-level keys: gateway, channels");
  }

  if (!sameKeys(config?.gateway, EXPECTED_GATEWAY_KEYS)) {
    errors.push("gateway must contain only mode and bind");
  } else {
    if (config.gateway.mode !== "local") errors.push('gateway.mode must be "local"');
    if (config.gateway.bind !== "loopback") errors.push('gateway.bind must be "loopback"');
  }

  if (!sameKeys(config?.channels, EXPECTED_CHANNEL_KEYS)) {
    errors.push("channels must contain only imessage");
  }

  const imessage = config?.channels?.imessage;
  if (!sameKeys(imessage, EXPECTED_IMESSAGE_KEYS)) {
    errors.push(`channels.imessage must contain exactly: ${EXPECTED_IMESSAGE_KEYS.join(", ")}`);
  }

  if (imessage?.enabled !== true) errors.push("channels.imessage.enabled must be true");
  if (imessage?.dmPolicy !== "allowlist") {
    errors.push('channels.imessage.dmPolicy must be "allowlist"');
  }
  if (!Array.isArray(imessage?.allowFrom) || imessage.allowFrom.length === 0) {
    errors.push("channels.imessage.allowFrom must contain at least one exact handle");
  } else {
    for (const handle of imessage.allowFrom) {
      if (!isExactHandle(handle)) errors.push(`invalid exact allowFrom handle: ${JSON.stringify(handle)}`);
    }
    if (new Set(imessage.allowFrom).size !== imessage.allowFrom.length) {
      errors.push("channels.imessage.allowFrom must not contain duplicates");
    }
  }
  if (imessage?.groupPolicy !== "disabled") {
    errors.push('channels.imessage.groupPolicy must be "disabled"');
  }
  if (!Array.isArray(imessage?.groupAllowFrom) || imessage.groupAllowFrom.length !== 0) {
    errors.push("channels.imessage.groupAllowFrom must be an empty array");
  }
  if (imessage?.configWrites !== false) {
    errors.push("channels.imessage.configWrites must be false");
  }

  for (const [key, value] of [["cliPath", imessage?.cliPath], ["dbPath", imessage?.dbPath]]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) {
      errors.push(`channels.imessage.${key} must be an absolute path`);
    }
  }

  walk(config, (key, value, keyPath) => {
    if (SECRET_KEY_PATTERN.test(key)) {
      errors.push(`secret-bearing key is forbidden: ${keyPath.join(".")}`);
    }
    if (typeof value !== "string") return;
    if (PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`placeholder value is forbidden in live config: ${keyPath.join(".")}`);
    }
    if (SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value))) {
      errors.push(`secret-like value is forbidden: ${keyPath.join(".")}`);
    }
  });

  return [...new Set(errors)];
}

export function assertValidConfig(config) {
  const errors = validateConfig(config);
  if (errors.length > 0) {
    throw new Error(`Unsafe OpenClaw configuration:\n- ${errors.join("\n- ")}`);
  }
  return config;
}

export function buildConfig(env) {
  const required = ["PAUL_IMESSAGE_HANDLE", "IMSG_CLI_PATH", "IMESSAGE_DB_PATH"];
  const missing = required.filter((key) => !env[key]?.trim());
  if (missing.length > 0) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);

  const handles = [
    env.PAUL_IMESSAGE_HANDLE.trim(),
    ...(env.IMESSAGE_EXTRA_ALLOW_FROM ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  ];

  return assertValidConfig({
    gateway: {
      mode: "local",
      bind: "loopback",
    },
    channels: {
      imessage: {
        enabled: true,
        cliPath: env.IMSG_CLI_PATH.trim(),
        dbPath: env.IMESSAGE_DB_PATH.trim(),
        dmPolicy: "allowlist",
        allowFrom: handles,
        groupPolicy: "disabled",
        groupAllowFrom: [],
        configWrites: false,
      },
    },
  });
}
