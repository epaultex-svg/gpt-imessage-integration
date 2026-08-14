#!/usr/bin/env node
import {
  invalidArgumentsResult,
  parseAgentE2EArguments,
  runAgentE2E,
} from "./lib/agent-e2e.mjs";

const options = parseAgentE2EArguments(process.argv.slice(2));
const result = options.valid
  ? await runAgentE2E({ send: options.send })
  : invalidArgumentsResult();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = ["dry_run", "verified"].includes(result.status) ? 0 : 1;
