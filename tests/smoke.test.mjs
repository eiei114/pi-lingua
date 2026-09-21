import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const publishWorkflow = await readFile(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
);
const autoReleaseWorkflow = await readFile(
  new URL("../.github/workflows/auto-release.yml", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("the package exposes only the extension entrypoint it actually ships", () => {
  assert.deepEqual(packageJson.pi, { extensions: ["./extensions"] });
  // The template's example resources must not survive into a shipped package.
  assert.equal(packageJson.pi.skills, undefined);
  assert.equal(packageJson.pi.prompts, undefined);
  assert.equal(packageJson.pi.themes, undefined);
  assert.ok(!packageJson.keywords.includes("agent-skill"));
});

test("the published tarball contains only real package content", () => {
  for (const entry of packageJson.files) {
    assert.doesNotMatch(entry, /skills|prompts|themes|packages|scaffold/, `stale files entry: ${entry}`);
  }
  assert.ok(packageJson.files.includes("extensions/"));
  assert.ok(packageJson.files.includes("lib/"));
});

test("the package is discoverable as a Pi package", () => {
  assert.ok(packageJson.keywords.includes("pi-package"));
});

test("publishing uses Trusted Publishing and is reachable from auto-release", () => {
  assert.match(publishWorkflow, /id-token:\s*write/);
  assert.match(publishWorkflow, /workflow_dispatch:/);
  assert.match(publishWorkflow, /npm publish --access public/);
  assert.match(autoReleaseWorkflow, /actions:\s*write/);
  assert.match(autoReleaseWorkflow, /contents:\s*write/);
  assert.match(autoReleaseWorkflow, /gh workflow run publish\.yml/);
});

test("ci runs typecheck, tests, the pack check, and the publish guard", () => {
  assert.match(packageJson.scripts.ci, /npm run typecheck/);
  assert.match(packageJson.scripts.ci, /npm test/);
  assert.match(packageJson.scripts.ci, /npm run pack:check/);
  assert.match(packageJson.scripts.ci, /npm run publish:guard/);
  assert.equal(packageJson.scripts["publish:guard"], "node scripts/check-no-npm-token.mjs");
});

test("the README documents the invariants a user must be able to rely on", () => {
  assert.match(readme, /## Install/);
  assert.match(readme, /## Commands/);
  assert.match(readme, /## Settings/);
  assert.match(readme, /## Security/);
  assert.match(readme, /never blocks/i);
});
