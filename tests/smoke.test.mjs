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

  // A list, heading or quote marker is not part of a sentence, and a wrapped list item or quote is
  // still one paragraph: stripping the marker before joining keeps "- `auto-release.yml` / dispatches
  // `publish.yml`" from being read as two line-scoped fragments. Without this, a marker line flushed
  // on its own and the continuation was never checked.
  const stripBlockMarkers = (line) => {
    let rest = line.trim();
    let previous;
    do {
      previous = rest;
      rest = rest
        .replace(/^>\s?/, "")
        .replace(/^(?:[-*+]|\d+\.)\s+/, "")
        .replace(/^#{1,6}\s+/, "")
        .trim();
    } while (rest !== previous);
    return rest;
  };
  const startsBlock = (line) => /^(?:>\s*)?(?:[-*+]|\d+\.)\s+/.test(line.trim()) || /^#{1,6}\s+/.test(line.trim());

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
    // A new list item or heading starts its own paragraph, so the wrapped continuation that follows
    // it belongs to that item and not to the block before it.
    if (startsBlock(trimmed)) flush();
    const text = stripBlockMarkers(trimmed);
    // A bare `>` or a marker with no content is a paragraph break, not a sentence to join.
    if (!text) {
      flush();
      continue;
    }
    paragraph.push({ line: index + 1, text });
    // A heading runs only to the end of its own line, and a line that closes its own sentence ends
    // the paragraph so the next line never borrows this one as its subject. A trailing file
    // extension keeps the paragraph open.
    if (/^#{1,6}\s+/.test(trimmed)) flush();
    if (/[.!?]\s*$/.test(text) && !/\.(?:yml|md|mjs|json|ts|js)`?$/i.test(text)) flush();
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
  // Comments and blank lines are not commands: the prose above a lookup names it too.
  const commands = block.lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const dispatchIndexes = commands
    .map((line, index) => ({
      line,
      index,
      workflow: line.match(/gh workflow run ([a-z-]+\.yml)/)?.[1],
    }))
    .filter((entry) => entry.workflow);
  const publishDispatch = dispatchIndexes.find((entry) => entry.workflow === "publish.yml");
  if (!publishDispatch) return [];

  const where = `docs/release.md:${block.line}`;
  const problems = [];
  // Without a failure gate, a failed watch still leads to the tag lookup and the dispatch, so
  // publish.yml can start for a tag the release run never created.
  const failureGate = commands.some((line) => {
    const match = line.match(/^set\s+-([A-Za-z]+)/);
    return Boolean(match) && match[1].includes("e");
  });
  if (!failureGate) {
    problems.push(`${where}: the dispatch block must set -e so a failed step stops the chain`);
  }
  if (!commands.slice(0, publishDispatch.index).some((line) => /gh run watch --exit-status/.test(line))) {
    problems.push(`${where}: the dispatch must come after the release run it watched`);
  }
  if (!commands.slice(publishDispatch.index + 1).some((line) => /gh run watch --exit-status/.test(line))) {
    problems.push(`${where}: the publish dispatch must be followed by a watch of its own run`);
  }

  for (const dispatch of dispatchIndexes) {
    // The run id has to come from this shell's own dispatch. Capturing the newest id before the
    // dispatch and selecting the newest id above it survives a lagging list result; `--limit 1`
    // resolves at run time instead, and a concurrent dispatch remains a residual race that the
    // guide states honestly rather than claiming to cover.
    const previous = dispatchIndexes.filter((entry) => entry.index < dispatch.index).at(-1);
    const windowStart = previous ? previous.index + 1 : 0;
    const before = commands.slice(windowStart, dispatch.index);
    const after = commands.slice(dispatch.index + 1);
    const baseline = before.find(
      (line) => /gh run list/.test(line) && /first\(\.\[\]\.databaseId\)\s*\/\/\s*0/.test(line),
    );
    const baselineVariable = baseline?.match(/^(\w+)=/)?.[1];
    if (!baselineVariable) {
      problems.push(`${where}: ${dispatch.workflow} needs a run-id baseline captured by the same shell before it`);
      continue;
    }
    const selection = after.find((line) =>
      new RegExp(`gh run list[^\n]*> \\$${baselineVariable}\\)`).test(line),
    );
    if (!selection) {
      problems.push(`${where}: ${dispatch.workflow} must select the run id above $${baselineVariable} after the dispatch`);
      continue;
    }
    // Direction matters: `gh run list` returns newest first, so only `first(...)` / `.[0]` picks the
    // run that appeared after the baseline. `last(...)` silently picks the OLDEST id above it — an
    // earlier dispatch — so the block would watch that run while claiming to watch its own. A
    // selection with no explicit direction is equally unpinned.
    const selectsNewest = /first\(|\.[[]0]/.test(selection) && !/last\(/.test(selection);
    if (!selectsNewest) {
      problems.push(`${where}: the run id selected after ${dispatch.workflow} must be the newest id above $${baselineVariable} (first(...) or .[0]), not the oldest`);
    }
    const selected = selection.match(/^(\w+)=/)?.[1];
    // The guard has to be `: "${VAR:?message}"`: a plain `: "${VAR}"` succeeds on an empty id and
    // the next command would watch an empty run id, so `:?` specifically is required here.
    if (!selected || !after.some((line) => new RegExp(`: "\\$\\{${selected}:\\?`).test(line))) {
      problems.push(`${where}: the run id selected after ${dispatch.workflow} must be asserted with :? so an empty id stops the block`);
    }
  }

  // The highest local tag is not the released tag when a lower version lands after a higher one.
  if (commands.some((line) => /--sort=-version:refname/.test(line))) {
    problems.push(`${where}: the published tag must come from the watched run, not the highest local tag`);
  }
  if (!commands.some((line) => /gh run view[^`]*--json headSha/.test(line))) {
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
  // A list item, an ordered item and a quote paragraph are wrapped the same way, and a block marker
  // used to flush the paragraph before the continuation was joined — the live hole at the previous
  // HEAD. Strip the marker, keep the paragraph open, and every shape is caught.
  for (const fixture of [
    "- `auto-release.yml` dispatches\n  `publish.yml` automatically.",
    "1. `auto-release.yml` dispatches\n   `publish.yml` automatically.",
    "> `auto-release.yml` dispatches\n> `publish.yml` automatically.",
  ]) {
    assert.deepEqual(
      affirmativeDispatchClaims("fixture", fixture),
      ["fixture:1: `auto-release.yml` dispatches `publish.yml` automatically."],
      `wrapped list/quote claim must be detected: ${JSON.stringify(fixture)}`,
    );
  }
  // The marker stripping must not turn separate items into one sentence, and must not swallow the
  // negation that keeps the accurate wording allowed.
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "- `auto-release.yml` creates the tag.\n- `publish.yml` publishes."),
    [],
  );
  assert.deepEqual(
    affirmativeDispatchClaims("fixture", "- `auto-release.yml` does not start\n  `publish.yml`."),
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

  // Prove the guard bites on the shapes it exists for: the pre-fix block (runtime-resolved run id,
  // highest local tag, no failure gate, no watch of the publish run) and each defect on its own.
  const unfixed = [
    "RUN=$(gh run list --workflow=auto-release.yml --limit 1 --json databaseId --jq '.[0].databaseId')",
    'gh run watch --exit-status "$RUN"',
    'git fetch --tags origin',
    "TAG=$(git tag --list 'v[0-9]*' --sort=-version:refname | head -1)",
    'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
  ];
  const unfixedProblems = releaseDispatchProblems({ line: 1, lines: unfixed });
  assert.equal(unfixedProblems.length, 5, `the pre-fix block must fail the guard: ${unfixedProblems}`);
  assert.ok(
    unfixedProblems.some((problem) => problem.includes("baseline")),
    `the pre-fix run lookup must be rejected: ${unfixedProblems}`,
  );

  const correct = [
    "set -euo pipefail",
    "BASELINE=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')",
    "gh workflow run auto-release.yml --ref main -f confirm_release=true",
    'RUN=$(gh run list --workflow=auto-release.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $BASELINE) | .databaseId) // empty")',
    ': "${RUN:?no run}"',
    'gh run watch --exit-status "$RUN"',
    'TAGGED_SHA=$(gh run view "$RUN" --json headSha --jq .headSha)',
    "TAG=$(git show \"$TAGGED_SHA:package.json\" | node -p 'JSON.parse(require(\"node:fs\").readFileSync(0,\"utf8\")).version')",
    "PUBLISH_BASELINE=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq 'first(.[].databaseId) // 0')",
    'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
    'PUBLISH_RUN=$(gh run list --workflow=publish.yml --limit 20 --json databaseId --jq "first(.[] | select(.databaseId > $PUBLISH_BASELINE) | .databaseId) // empty")',
    ': "${PUBLISH_RUN:?no run}"',
    'gh run watch --exit-status "$PUBLISH_RUN"',
  ];
  assert.deepEqual(releaseDispatchProblems({ line: 1, lines: correct }), []);

  // The direction is pinned, not just the presence of a baseline: `last(...)` is the oldest id above
  // the baseline, so the block would watch an earlier run while claiming to watch the one it started.
  // Both dispatch pairs are rejected, because both had the inverted selector.
  const inverted = correct.map((line) => line.replace("first(.[] | select(", "last(.[] | select("));
  assert.ok(
    inverted.filter((line) => line.includes('last(.[]')).length === 2,
    `the rejection fixture must replace both selectors: ${inverted}`,
  );
  assert.deepEqual(releaseDispatchProblems({ line: 1, lines: inverted }), [
    "docs/release.md:1: the run id selected after auto-release.yml must be the newest id above $BASELINE (first(...) or .[0]), not the oldest",
    "docs/release.md:1: the run id selected after publish.yml must be the newest id above $PUBLISH_BASELINE (first(...) or .[0]), not the oldest",
  ]);

  // The selection runs over a multi-id list whenever a second dispatch exists. The order `gh run
  // list` returns is newest-first (observed on this repository: `--limit 20` over auto-release runs
  // yields 42402923789 2026-11-07T18:46:15Z down to 35563903193 2026-09-21T05:15:04Z), so simulate
  // the documented filter over such a list instead of trusting the expression's shape.
  const selectRun = (ids, baseline, direction) => {
    const above = ids.filter((id) => id > baseline);
    return above.length === 0 ? null : direction === "newest" ? above[0] : above.at(-1);
  };
  const newestFirst = [302, 301, 100];
  assert.equal(selectRun(newestFirst, 100, "newest"), 302);
  assert.equal(selectRun(newestFirst, 100, "oldest"), 301);
  assert.ok(selectRun(newestFirst, 100, "newest") > selectRun(newestFirst, 100, "oldest"));
  // A single-run list is direction-blind: both selectors agree, which is how the inversion stayed
  // invisible in the one-run case.
  assert.equal(selectRun([301, 100], 100, "newest"), selectRun([301, 100], 100, "oldest"));
  // No id above the baseline means no run yet; both directions have to say so instead of watching "".
  assert.equal(selectRun([100], 100, "newest"), null);

  // A dispatch whose capture is never asserted fails, because an empty id would be watched as "".
  assert.deepEqual(
    releaseDispatchProblems({ line: 1, lines: correct.filter((line) => !line.includes("${PUBLISH_RUN")) }),
    [
      "docs/release.md:1: the run id selected after publish.yml must be asserted with :? so an empty id stops the block",
    ],
  );

  // A plain expansion must not satisfy the guard: `: "${PUBLISH_RUN}"` succeeds on an empty id.
  assert.deepEqual(
    releaseDispatchProblems({
      line: 1,
      lines: correct.map((line) =>
        line === ': "${PUBLISH_RUN:?no run}"' ? ': "${PUBLISH_RUN}"' : line,
      ),
    }),
    [
      "docs/release.md:1: the run id selected after publish.yml must be asserted with :? so an empty id stops the block",
    ],
  );
  assert.deepEqual(
    releaseDispatchProblems({
      line: 1,
      lines: correct.map((line) => (line === ': "${RUN:?no run}"' ? ': "${RUN}"' : line)),
    }),
    [
      "docs/release.md:1: the run id selected after auto-release.yml must be asserted with :? so an empty id stops the block",
    ],
  );

  // `--commit` pins a commit, not the run: `main` moving on between push and dispatch, or a second
  // dispatch of the same commit, still leaves the newer/older run ambiguous.
  assert.deepEqual(
    releaseDispatchProblems({
      line: 1,
      lines: [
        'set -euo pipefail',
        'SHA=$(git rev-parse origin/main)',
        'RUN=$(gh run list --workflow=auto-release.yml --commit "$SHA" --limit 1 --json databaseId --jq \'first(.[].databaseId)\')',
        'gh run watch --exit-status "$RUN"',
        'TAGGED_SHA=$(gh run view "$RUN" --json headSha --jq .headSha)',
        'gh workflow run publish.yml --ref "$TAG" -f ref="$TAG"',
      ],
    }),
    [
      "docs/release.md:1: the publish dispatch must be followed by a watch of its own run",
      "docs/release.md:1: publish.yml needs a run-id baseline captured by the same shell before it",
    ],
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
