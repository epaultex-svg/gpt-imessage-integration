#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { assertValidConfig } from "./lib/config.mjs";

const input = process.argv[2];
if (!input) {
  console.error("Usage: npm run validate -- <config.json>");
  process.exitCode = 1;
} else {
  try {
    const target = path.resolve(input);
    const raw = await readFile(target, "utf8");
    assertValidConfig(JSON.parse(raw));
    console.log(`Valid safe config: ${target}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
