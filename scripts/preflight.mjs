#!/usr/bin/env node
import { runPreflight } from "./lib/preflight.mjs";

const result = await runPreflight();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === "ready" ? 0 : 1;
