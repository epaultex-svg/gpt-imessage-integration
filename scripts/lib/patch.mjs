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
  if (typeof patchPath === "string" && !path.isAbsolute(patchPath)) {
    throw new Error("--patch must resolve to an absolute path");
  }

  const [existingRaw, patchValue, configStat] = await Promise.all([
    readFile(configPath, "utf8"),
    typeof patchPath === "string" ? readFile(patchPath, "utf8") : structuredClone(patchPath),
    stat(configPath),
  ]);

  let existing;
  let patch;
  try {
    existing = JSON.parse(existingRaw);
  } catch (error) {
    throw new Error(`Existing config must be strict JSON; refusing lossy rewrite: ${error.message}`);
  }
  if (typeof patchValue === "string") {
    try {
      patch = JSON.parse(patchValue);
    } catch (error) {
      throw new Error(`Patch must be strict JSON: ${error.message}`);
    }
  } else {
    patch = patchValue;
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

export async function restoreManagedBackup(configPath, backupPath) {
  if (!path.isAbsolute(configPath) || !path.isAbsolute(backupPath)) {
    throw new Error("config and backup paths must be absolute");
  }
  const backupStat = await stat(backupPath);
  const temporaryPath = `${configPath}.rollback.${process.pid}.${randomUUID()}`;
  try {
    await copyFile(backupPath, temporaryPath, constants.COPYFILE_EXCL);
    await chmod(temporaryPath, backupStat.mode & 0o777);
    await rename(temporaryPath, configPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw new Error(`Rollback restore failed: ${error.message}`);
  }
  return { configPath, backupPath };
}
