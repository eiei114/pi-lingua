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
  const claims = [];
  const lines = content.split(/\r?\n/);
  let paragraph = [];

  // Physical line breaks inside a Markdown paragraph are soft wraps, so a claim split over two
  // lines has to be checked as one sentence. The pointers here name ".yml" paths, whose period is
  // not a sentence end, so sentences are only split on punctuation that closes a clause.
  const flush = () => {
    if (paragraph.length === 0) return;
    const joined = paragraph.map((entry) => entry.text).join(" ");
    // Mask the file suffixes before splitting: `auto-release.yml and publish.yml` would otherwise
    // be cut at the period inside the path, and the claim would lose its subject. The mask keeps
    // the same length, so the masked offsets still index the original sentence.
    const masked = joined.replace(/\.yml/gi, "_yml");
    let offset = 0;
    for (const sentence of masked.split(/(?<=[.!?:])\s+/)) {
      const raw = joined.slice(offset, offset + sentence.length);
      offset += sentence.length + 1;
      const start = sentence.search(/auto-release_yml/i);
      if (start === -1) continue;
      const tail = sentence.slice(start);
      if (!/publish_yml/i.test(tail)) continue;
      const verb = tail.match(dispatchVerbs);
      if (!verb) continue;
      // "auto-release.yml does not start publish.yml" negates before the verb and is allowed.
      if (negations.test(tail.slice(0, verb.index))) continue;
      claims.push(`${label}:${paragraph[0].line}: ${raw.trim()}`);
    }
    paragraph = [];
  };

  // Prose only: a fenced shell block runs the dispatches by hand, and joining its lines would read
  // the separate `-f ref` commands as one claim.
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (!trimmed) {
      flush();
      continue;
    }
    // A line that closes its own sentence ends the paragraph, so the next line never borrows this
    // one as its subject. A trailing file extension keeps it open.
    paragraph.push({ line: index + 1, text: trimmed });
    if (/^(?:[-*+|>#]|\d+\.)/.test(trimmed)) flush();
    if (/[.!?]\s*$/.test(trimmed) && !/\.(?:yml|md|mjs|json|ts|js)`?$/i.test(trimmed)) flush();
  }
  flush();
  return claims;
}

/** Fenced shells commands, so a release step is inspected as the sequence it actually runs. */
function bashBlocks(markdown) {
  const blocks = [];
  let open = null;
  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!open) {
      if (/^```(?:bash|sh|shell)?$/.test(trimmed)) {
        open = { line: index + 2, lines: [] };
      }
      continue;
    }
    if (/^```$/.test(trimmed)) {
      blocks.push(open);
      open = null;
      continue;
    }
    open.lines.push(line);
  }
  if (open) blocks.push(open);
  return blocks;
}

function releaseDispatchProblems(block) {
  const dispatchIndex = block.lines.findIndex((line) => /gh workflow run publish\.yml/.test(line));
  if (dispatchIndex === -1) return [];

  const where = `docs/release.md:${block.line}`;
  const problems = [];
  // Without a failure gate, a failed watch still leads to the fetch, the tag lookup and the
  // dispatch, so publish.yml can start for a tag the release run never created.
  const failureGate = block.lines.some((line) => {
    const match = line.trim().match(/^set\s+-([A-Za-z]+)/);
    return Boolean(match) && match[1].includes("e");
  });
  if (!failureGate) {
    problems.push(`${where}: the dispatch block must set -e so a failed step stops the chain`);
  }
  if (!block.lines.slice(0, dispatchIndex).some((line) => /gh run watch --exit-status/.test(line))) {
    problems.push(`${where}: the dispatch must come after the release run it watched`);
  }
  for (const line of block.lines) {
    // `--limit 1` alone resolves at run time: a second dispatch or a lagging list result makes the
    // watch track a different run, so the run has to be named by the commit it was dispatched for.
    if (/gh run list/.test(line) && !/--commit/.test(line)) {
      problems.push(`${where}: gh run list must be pinned to the commit it means to watch: ${line.trim()}`);
    }
    // The highest local tag is not the released tag when a lower version lands after a higher one.
    if (/--sort=-version:refname/.test(line)) {
      problems.push(`${where}: the published tag must come from the watched run, not the highest local tag: ${line.trim()}`);
    }
  }
  if (!block.lines.some((line) => /gh run view[^`]*--json headSha/.test(line))) {
    problems.push(`${where}: the published tag must be read from the watched run's headSha`);
  }
  return problems;
}

function publishDispatchCommands(releaseDoc) {
  return releaseDoc
    .split(/\r?\n/)
    .filter((line) => /gh workflow run publish\.yml/.test(line));
}

/** Shell quotes are not part of a ref: `'main'` is still main, and `'v0.6.5'` is still that tag. */
function stripShellQuotes(value) {
  const trimmed = value.trim();
  for (const quote of ['"', "'"]) {
    if (trimmed.length >= 2 && trimmed.startsWith(quote) && trimmed.endsWith(quote)) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function publishDispatchRefs(command) {
  const workflowRef = command.match(/--ref\s+("[^"]*"|'[^']*'|[^\s"']+)/);
  const inputRef = command.match(/-f\s+ref=("[^"]*"|'[^']*'|[^\s"']+)/);
  if (!workflowRef || !inputRef) return null;
  return {
    workflowRef: stripShellQuotes(workflowRef[1]),
    inputRef: stripShellQuotes(inputRef[1]),
  };
}

function publishDispatchProblems(command) {
  const refs = publishDispatchRefs(command);
  if (!refs) return [`${command}: must pin both --ref and -f ref`];
  const problems = [];
  for (const ref of [refs.workflowRef, refs.inputRef]) {
    if (ref === "") problems.push(`${command}: the published ref must not be empty`);
    if (ref.toLowerCase() === "main") problems.push(`${command}: must not publish on main`);
  }
  if (refs.workflowRef !== refs.inputRef) {
    problems.push(`${command}: --ref and -f ref must name the same release tag`);
  }
  return [...new Set(problems)];
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
  // The same claim wrapped over two physical lines is still one sentence, and the README is
  // wrapped: line-scoped matching missed exactly the shape the guard exists for.
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "`auto-release.yml` dispatches\n`publish.yml` automatically."),
    ["fixture:1: `auto-release.yml` dispatches `publish.yml` automatically."],
  );
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "`auto-release.yml` does not start\n`publish.yml`."),
    [],
  );

  // The documented two-step flow must still dispatch publish.yml by hand, pinned to the tag that
  // auto-release.yml created — never to main, and never to two different refs in one command.
  const commands = publishDispatchCommands(releaseDoc);
  assert.notEqual(commands.length, 0, "docs/release.md must document the publish.yml dispatch");
  for (const command of commands) {
    assert.deepEqual(publishDispatchProblems(command), [], `unsafe documented publish dispatch: ${command}`);
  }
  // Prove the ref guards see through shell quotes instead of comparing the quoting style.
  assert.deepEqual(
    publishDispatchProblems("gh workflow run publish.yml --ref 'main' -f ref='main'"),
    ["gh workflow run publish.yml --ref 'main' -f ref='main': must not publish on main"],
  );
  assert.deepEqual(publishDispatchProblems("gh workflow run publish.yml --ref 'v0.6.5' -f ref='v0.6.5'"), []);
  const mixedRefs = 'gh workflow run publish.yml --ref "v0.6.5" -f ref="main"';
  assert.deepEqual(publishDispatchProblems(mixedRefs), [
    `${mixedRefs}: must not publish on main`,
    `${mixedRefs}: --ref and -f ref must name the same release tag`,
  ]);
});

test("the documented publish dispatch waits for the run it names and publishes that run's tag", async () => {
  const releaseDoc = await readFile(new URL("../docs/release.md", import.meta.url), "utf8");
  const dispatchBlocks = bashBlocks(releaseDoc).filter((block) =>
    block.lines.some((line) => /gh workflow run publish\.yml/.test(line)),
  );
  assert.notEqual(dispatchBlocks.length, 0, "docs/release.md must keep its publish dispatch instructions");
  const problems = dispatchBlocks.flatMap(releaseDispatchProblems);
  assert.deepEqual(problems, [], `docs/release.md publish dispatch can race the release it means: ${problems}`);

  // Prove the guard bites on the shapes it exists for: the unfixed block (runtime-resolved run id,
  // highest local tag, no failure gate) and each defect on its own.
  const unfixed = [
    "RUN=$(gh run list --workflow=auto-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
    'gh run watch --exit-status "$RUN"',
    'git fetch --tags origin',
    "TAG=$(git tag --list 'v[0-9]*' --sort=-version:refname | head -1)",
    'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
  ];
  const unfixedProblems = releaseDispatchProblems({ line: 1, lines: unfixed });
  assert.equal(unfixedProblems.length, 4, `the pre-fix block must fail the guard: ${unfixedProblems}`);
  assert.deepEqual(
    releaseDispatchProblems({
      line: 1,
      lines: [
        'set -euo pipefail',
        'SHA=$(git rev-parse origin/main)',
        'RUN=$(gh run list --workflow=auto-release.yml --commit "$SHA" --limit 1 --json databaseId --jq \'first(.[].databaseId)\')',
        'gh run watch --exit-status "$RUN"',
        'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
      ],
    }),
    ["docs/release.md:1: the published tag must be read from the watched run's headSha"],
  );
  assert.deepEqual(
    releaseDispatchProblems({
      line: 1,
      lines: [
        'set -euo pipefail',
        'gh run watch --exit-status "$RUN"',
        'TAGGED_SHA=$(gh run view "$RUN" --json headSha --jq .headSha)',
        'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
      ],
    }),
    [],
  );
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
