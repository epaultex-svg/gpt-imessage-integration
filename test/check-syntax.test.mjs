import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { checkSyntax, discoverMjsFiles } from "../scripts/check-syntax.mjs";

test("syntax discovery is recursive, deterministic, and limited to mjs", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".local-check-"));
  try {
    await mkdir(path.join(directory, "scripts", "nested"), { recursive: true });
    await mkdir(path.join(directory, "test"), { recursive: true });
    await writeFile(path.join(directory, "scripts", "z.mjs"), "export const z = 1;\n");
    await writeFile(path.join(directory, "scripts", "nested", "a.mjs"), "export const a = 1;\n");
    await writeFile(path.join(directory, "scripts", "ignored.js"), "not valid javascript {{{\n");
    await writeFile(path.join(directory, "test", "b.mjs"), "export const b = 1;\n");

    assert.deepEqual(await discoverMjsFiles(["test", "scripts"], directory), [
      path.join("scripts", "nested", "a.mjs"),
      path.join("scripts", "z.mjs"),
      path.join("test", "b.mjs"),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syntax check detects invalid modules", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".local-check-"));
  try {
    await mkdir(path.join(directory, "scripts"), { recursive: true });
    await mkdir(path.join(directory, "test"), { recursive: true });
    await writeFile(path.join(directory, "scripts", "valid.mjs"), "export const valid = true;\n");
    await writeFile(path.join(directory, "test", "invalid.mjs"), "export const = ;\n");

    const result = await checkSyntax({ cwd: directory });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [path.join("test", "invalid.mjs")]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
