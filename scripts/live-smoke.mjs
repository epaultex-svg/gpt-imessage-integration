#!/usr/bin/env node
import {
  invalidArgumentsResult,
  parseLiveSmokeArguments,
  runLiveSmoke,
} from "./lib/live-smoke.mjs";

const options = parseLiveSmokeArguments(process.argv.slice(2));
const result = options.valid
  ? await runLiveSmoke({ send: options.send })
  : invalidArgumentsResult();

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = ["dry_run", "verified"].includes(result.status) ? 0 : 1;
