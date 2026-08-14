import { constants } from "node:fs";
import { chmod, copyFile, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { assertValidConfig } from "./config.mjs";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function mergeManagedPatch(existing, patch) {
  if (!isPlainObject(existing)) throw new Error("Existing OpenClaw config must be a JSON object");
  assertValidConfig(patch);

  return {
    ...existing,
    gateway: {
      ...(isPlainObject(existing.gateway) ? existing.gateway : {}),
      ...patch.gateway,
    },
    channels: {
      ...(isPlainObject(existing.channels) ? existing.channels : {}),
      imessage: structuredClone(patch.channels.imessage),
    },
  };
}

export async function applyManagedPatch(configPath, patchPath, now = new Date()) {
  if (!path.isAbsolute(configPath)) throw new Error("--config must resolve to an absolute path");
  if (!path.isAbsolute(patchPath)) throw new Error("--patch must resolve to an absolute path");

  const [existingRaw, patchRaw, configStat] = await Promise.all([
    readFile(configPath, "utf8"),
    readFile(patchPath, "utf8"),
    stat(configPath),
  ]);

  let existing;
  let patch;
  try {
    existing = JSON.parse(existingRaw);
  } catch (error) {
    throw new Error(`Existing config must be strict JSON; refusing lossy rewrite: ${error.message}`);
  }
  try {
    patch = JSON.parse(patchRaw);
  } catch (error) {
    throw new Error(`Patch must be strict JSON: ${error.message}`);
  }

  const merged = mergeManagedPatch(existing, patch);
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.backup.${stamp}-${process.pid}`;
  const temporaryPath = `${configPath}.tmp.${process.pid}.${randomUUID()}`;
  const mode = configStat.mode & 0o777;

  await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  await chmod(backupPath, mode);

  try {
    await writeFile(temporaryPath, `${JSON.stringify(merged, null, 2)}\n`, {
      flag: "wx",
      mode,
    });
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Backup created at ${backupPath}, but patch was not applied: ${error.message}`);
  }

  return { backupPath, configPath, merged };
}
