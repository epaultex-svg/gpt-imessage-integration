#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { applyManagedPatch } from "./lib/patch.mjs";

function flagValue(argv, flag) {
  const index = argv.indexOf(flag);
  const value = index === -1 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return path.resolve(value);
}

try {
  const argv = process.argv.slice(2);
  const configPath = flagValue(argv, "--config");
  const patchPath = flagValue(argv, "--patch");
  const result = await applyManagedPatch(configPath, patchPath);
  console.log(`Applied validated iMessage patch: ${result.configPath}`);
  console.log(`Backup preserved: ${result.backupPath}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
