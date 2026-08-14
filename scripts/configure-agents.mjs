#!/usr/bin/env node
import {
  configureAgentMcp,
  invalidArgumentsResult,
  parseConfigureArguments,
} from "./lib/agent-mcp.mjs";

const options = parseConfigureArguments(process.argv.slice(2));
const result = options.valid
  ? await configureAgentMcp({ apply: options.apply })
  : invalidArgumentsResult();

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = ["ready", "changes_planned", "configured"].includes(result.status) ? 0 : 1;
