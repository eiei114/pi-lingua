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

function workflowTriggers(content) {
  const lines = content.split(/\r?\n/);
  const onIndex = lines.findIndex((line) => /^on:\s*$/.test(line));
  assert.notEqual(onIndex, -1, "workflow must declare an event map");
  const triggers = [];
  for (let index = onIndex + 1; index < lines.length && /^\s/.test(lines[index]); index += 1) {
    const match = lines[index].match(/^  ([\w-]+):/);
    if (match) triggers.push(match[1]);
  }
  return triggers;
}

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

test("release and publishing require explicit workflow dispatch", () => {
  assert.match(publishWorkflow, /id-token:\s*write/);
  assert.deepEqual(workflowTriggers(publishWorkflow), ["workflow_dispatch"]);
  assert.match(publishWorkflow, /workflow_dispatch:/);
  assert.match(publishWorkflow, /npm publish --access public/);
  assert.deepEqual(workflowTriggers(autoReleaseWorkflow), ["workflow_dispatch"]);
  assert.match(autoReleaseWorkflow, /confirm_release:[\s\S]*?required: true[\s\S]*?type: boolean/);
  assert.match(autoReleaseWorkflow, /if: github\.ref == 'refs\/heads\/main' && inputs\.confirm_release/);
  assert.match(autoReleaseWorkflow, /contents:\s*write/);
  assert.match(autoReleaseWorkflow, /git rev-parse HEAD\^/);
  assert.doesNotMatch(autoReleaseWorkflow, /gh workflow run publish\.yml/);
});

test("CI runs the actual Pi SDK behavior smoke and its release checks", () => {
  assert.match(packageJson.scripts.ci, /npm run typecheck/);
  assert.match(packageJson.scripts.ci, /npm test/);
  assert.match(packageJson.scripts.ci, /npm run review:guardrails/);
  assert.match(packageJson.scripts.ci, /npm run pack:check/);
  assert.match(packageJson.scripts.ci, /npm run publish:guard/);
  assert.match(packageJson.scripts.ci, /npm run smoke:pi/);
  assert.equal(packageJson.scripts["publish:guard"], "node scripts/check-no-npm-token.mjs");
  assert.equal(packageJson.scripts["smoke:pi"], "node scripts/pi-sdk-smoke.mjs");
});

test("SDK 1.2.0 pins are exact for development while published peer ranges stay unchanged", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const names = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  for (const name of names) {
    assert.equal(packageJson.devDependencies[name], "1.2.0");
    assert.equal(lock.packages[`node_modules/${name}`].version, "1.2.0");
  }
  assert.deepEqual(packageJson.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
    "@earendil-works/pi-tui": "*",
  });
});

test("the README documents the invariants a user must be able to rely on", () => {
  assert.match(readme, /## Install/);
  assert.match(readme, /## Commands/);
  assert.match(readme, /## Settings/);
  assert.match(readme, /## Security/);
  assert.match(readme, /never blocks/i);
});
