#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildConfig } from "./lib/config.mjs";

function outputPath(argv) {
  const outputIndex = argv.indexOf("--output");
  if (outputIndex === -1) return path.resolve(".local/openclaw.imessage.patch.json");
  const value = argv[outputIndex + 1];
  if (!value || value.startsWith("--")) throw new Error("--output requires a path");
  return path.resolve(value);
}

try {
  const target = outputPath(process.argv.slice(2));
  const config = buildConfig(process.env);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(`Wrote validated local config: ${target}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
