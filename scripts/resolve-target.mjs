#!/usr/bin/env node
import {
  invalidArgumentsResult,
  parseTargetResolverArguments,
  resolveTarget,
} from "./lib/target-resolver.mjs";

const options = parseTargetResolverArguments(process.argv.slice(2));
const resolution = options.valid
  ? await resolveTarget({ write: options.write, outputPath: options.outputPath })
  : invalidArgumentsResult();

process.stdout.write(`${JSON.stringify(resolution)}\n`);
process.exitCode = ["dry_run", "written", "unchanged"].includes(resolution.status) ? 0 : 1;
