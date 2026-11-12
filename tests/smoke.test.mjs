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
  assert.match(autoReleaseWorkflow, /run: node scripts\/check-release-version\.mjs/);
  assert.doesNotMatch(autoReleaseWorkflow, /git rev-parse HEAD\^/);
  assert.doesNotMatch(autoReleaseWorkflow, /gh workflow run publish\.yml/);
  // A REST dispatch (`gh api ... /dispatches`) names the workflow file too, so any mention of
  // publish.yml in this workflow means it starts publishing again.
  assert.doesNotMatch(autoReleaseWorkflow, /publish\.yml/);
});

// auto-release.yml stops at the tag and release, so no document may claim it starts publish.yml.
// A negated statement ("It does not start `publish.yml`", "never dispatches") is accurate and must
// stay allowed; only an affirmative claim is a contradiction.
const dispatchVerbs = /\b(?:dispatches|dispatch|starts|start|triggers|trigger|launches|launch|invokes|invoke|calls|call|runs|run)\b/i;
const negations = /\b(?:not|never|neither|no longer|doesn't|don't|isn't|won't)\b/i;

function affirmativeDispatchClaims(label, content) {
  return content.split(/\r?\n/).flatMap((line, index) => {
    // Sentence-scoped: a period that ends a sentence counts, the one inside ".yml" does not.
    const masked = line.replace(/\.yml/gi, "_yml");
    const start = masked.search(/auto-release_yml/i);
    if (start === -1) return [];
    const sentence = masked.slice(start).split(".")[0];
    if (!/publish_yml/i.test(sentence)) return [];
    const verb = sentence.match(dispatchVerbs);
    if (!verb) return [];
    // "auto-release.yml does not start publish.yml" negates before the verb and is allowed.
    if (negations.test(sentence.slice(0, verb.index))) return [];
    return [`${label}:${index + 1}: ${line.trim()}`];
  });
}

function publishDispatchCommands(releaseDoc) {
  return releaseDoc
    .split(/\r?\n/)
    .filter((line) => /gh workflow run publish\.yml/.test(line));
}

test("release docs and auto-release.yml agree that publishing is a separate dispatch", async () => {
  const releaseDoc = await readFile(new URL("../docs/release.md", import.meta.url), "utf8");
  for (const [label, content] of [
    ["docs/release.md", releaseDoc],
    ["README.md", readme],
  ]) {
    const claims = affirmativeDispatchClaims(label, content);
    assert.deepEqual(claims, [], `${label} claims auto-release.yml dispatches publish.yml: ${claims}`);
  }
  // Prove the guard bites on the claim it exists for and still tolerates the negated wording.
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "`auto-release.yml` dispatches `publish.yml` automatically."),
    ["fixture:1: `auto-release.yml` dispatches `publish.yml` automatically."],
  );
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "It does not start `publish.yml`, and neither does `auto-release.yml`."),
    [],
  );

  // The documented two-step flow must still dispatch publish.yml by hand, pinned to the tag that
  // auto-release.yml created — never to main, and never to two different refs in one command.
  const commands = publishDispatchCommands(releaseDoc);
  assert.notEqual(commands.length, 0, "docs/release.md must document the publish.yml dispatch");
  for (const command of commands) {
    const workflowRef = command.match(/--ref\s+"?([^\s"]+)"?/);
    const inputRef = command.match(/-f\s+ref=("?)([^\s"]+)\1/);
    assert.ok(workflowRef && inputRef, `documented publish dispatch must pin --ref and -f ref: ${command}`);
    for (const ref of [workflowRef[1], inputRef[2]]) {
      assert.notEqual(ref.toLowerCase(), "main", `publish dispatch must not run on main: ${command}`);
    }
    assert.equal(workflowRef[1], inputRef[2], `--ref and -f ref must name the same release tag: ${command}`);
  }
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

test("SDK development pins are exact and match the lockfile while published peer ranges stay unchanged", async () => {
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const names = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-tui",
  ];
  for (const name of names) {
    const pinnedVersion = packageJson.devDependencies[name];
    assert.match(pinnedVersion, /^\d+\.\d+\.\d+$/, `${name} must use an exact SDK version`);
    assert.equal(lock.packages[`node_modules/${name}`].version, pinnedVersion);
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
