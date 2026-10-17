import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const autoRelease = readFileSync(
  new URL("../.github/workflows/auto-release.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const publish = readFileSync(
  new URL("../.github/workflows/publish.yml", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const releaseGuide = readFileSync(
  new URL("../docs/release.md", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");

function eventTriggers(workflow) {
  const normalized = workflow.replace(/\r\n/g, "\n");
  const start = normalized.indexOf("\non:\n");
  const end = normalized.indexOf("\npermissions:\n", start);
  assert.notEqual(start, -1, "workflow must declare event triggers");
  assert.notEqual(end, -1, "workflow must declare permissions after triggers");
  return normalized.slice(start, end);
}

test("release and publish workflows require explicit dispatch confirmation", () => {
  const autoReleaseEvents = eventTriggers(autoRelease.replace(/\n/g, "\r\n"));
  const publishEvents = eventTriggers(publish.replace(/\n/g, "\r\n"));

  for (const [events, confirmation] of [
    [autoReleaseEvents, "confirm_release"],
    [publishEvents, "confirm_publish"],
  ]) {
    const eventNames = [...events.matchAll(/^  ([\w-]+):/gm)].map((match) => match[1]);
    assert.deepEqual(eventNames, ["workflow_dispatch"]);
    assert.match(events, new RegExp(`^      ${confirmation}:\\n        description:`, "m"));
    assert.match(events, /^        required: true$/m);
    assert.match(events, /^        type: boolean$/m);
  }

  assert.match(autoRelease, /^    if: \$\{\{ inputs\.confirm_release \}\}$/m);
  assert.match(publish, /^    if: \$\{\{ inputs\.confirm_publish \}\}$/m);
  assert.match(autoRelease, /confirm_publish=true/);
});

test("release guide documents manual dispatch after pushing version changes", () => {
  const dispatch = "gh workflow run auto-release.yml --ref main -f confirm_release=true";
  assert.equal(releaseGuide.split(dispatch).length - 1, 2);
  assert.match(
    releaseGuide,
    /After manually dispatching .*auto-release\.yml.* on `main` with\s+`confirm_release=true`/,
  );
  assert.match(releaseGuide, /does\s+not run automatically when the version change is pushed/);
  assert.doesNotMatch(
    releaseGuide,
    /auto-release\.yml` detects the `package\.json` version change on `main`/,
  );
});

test("auto release rejects older versions before tag creation or publish dispatch", () => {
  const guard = autoRelease.indexOf(
    'if [ "$HIGHEST_VERSION" != "$CURRENT_VERSION" ]; then',
  );
  assert.notEqual(guard, -1);
  assert.match(autoRelease, /HIGHEST_VERSION=.*sort -V/);
  assert.match(
    autoRelease,
    /is older than latest tag \$\{PREVIOUS_VERSION\}; skipping auto release\./,
  );
  assert.match(
    autoRelease.slice(guard),
    /released=false[\s\S]*?exit 0[\s\S]*?fi/,
  );
  assert.ok(guard < autoRelease.indexOf('if git tag -l "$TAG"'));
  assert.ok(guard < autoRelease.indexOf('git tag "$TAG"'));
  assert.ok(guard < autoRelease.indexOf("gh workflow run publish.yml"));
});
