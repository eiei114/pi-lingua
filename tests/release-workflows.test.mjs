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
