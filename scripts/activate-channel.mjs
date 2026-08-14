#!/usr/bin/env node
import {
  activateChannel,
  invalidArgumentsResult,
  parseActivationArguments,
} from "./lib/activation.mjs";

const options = parseActivationArguments(process.argv.slice(2));
const result = options.valid
  ? await activateChannel({ apply: options.apply })
  : invalidArgumentsResult();

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = ["dry_run", "activated", "rolled_back"].includes(result.status) ? 0 : 1;
