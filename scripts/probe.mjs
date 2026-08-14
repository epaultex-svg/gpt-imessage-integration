#!/usr/bin/env node
import {
  invalidArgumentsResult,
  probeArgumentsValid,
  runReadinessProbe,
} from "./lib/readiness-probe.mjs";

const args = process.argv.slice(2);
const result = probeArgumentsValid(args)
  ? await runReadinessProbe()
  : invalidArgumentsResult();

process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.status === "ready" ? 0 : 1;
