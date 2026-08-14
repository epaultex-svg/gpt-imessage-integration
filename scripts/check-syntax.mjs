#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function discoverMjsFiles(roots = ["scripts", "test"], cwd = process.cwd()) {
  const files = [];
  const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

  async function visit(relativeDirectory) {
    const entries = await readdir(path.resolve(cwd, relativeDirectory), { withFileTypes: true });
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(relativePath);
    }
  }

  for (const root of [...roots].sort(compare)) {
    await visit(root);
  }
  return files;
}

export async function checkSyntax({
  roots = ["scripts", "test"],
  cwd = process.cwd(),
  run = spawnSync,
} = {}) {
  const files = await discoverMjsFiles(roots, cwd);
  const failures = [];
  for (const file of files) {
    const checked = run(process.execPath, ["--check", path.resolve(cwd, file)], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (checked.status !== 0) failures.push(file);
  }
  return { ok: failures.length === 0, files, failures };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await checkSyntax();
  if (result.ok) {
    process.stdout.write(`Syntax OK: ${result.files.length} files\n`);
  } else {
    process.stderr.write(`Syntax failed: ${result.failures.join(", ")}\n`);
    process.exitCode = 1;
  }
}
