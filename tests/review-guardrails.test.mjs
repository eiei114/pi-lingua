import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { validateWorkflowGuardrails } from "../scripts/check-review-guardrails.mjs";
import { parsePackResult } from "../scripts/check-review-guardrails.mjs";

const FIXTURE_DIR = fileURLToPath(new URL("fixtures/review-guardrails", import.meta.url));

async function validateFixture(name) {
  const content = await readFile(join(FIXTURE_DIR, name), "utf8");
  return validateWorkflowGuardrails({ relativePath: `fixtures/${name}`, content });
}

test("G8 workflow validator accepts a read-only PR workflow fixture", async () => {
  assert.deepEqual(await validateFixture("valid-pr-readonly.yml"), []);
});

test("G8 workflow validator rejects PR workflows without explicit permissions", async () => {
  const problems = await validateFixture("invalid-missing-permissions.yml");
  assert.match(problems.join("\n"), /must declare top-level permissions with contents: read/);
});

test("G8 workflow validator recognizes aliased pull_request triggers", async () => {
  const problems = await validateFixture("invalid-aliased-trigger.yml");
  assert.match(problems.join("\n"), /must declare top-level permissions with contents: read/);
});

test("G8 workflow validator rejects write permissions in PR jobs", async () => {
  const problems = await validateFixture("invalid-write-permissions.yml");
  assert.match(problems.join("\n"), /must not grant contents: write/);
});

test("G8 workflow validator rejects persisted checkout credentials in PR workflows", async () => {
  const problems = await validateFixture("invalid-checkout-credentials.yml");
  assert.match(problems.join("\n"), /actions\/checkout in a PR workflow must set persist-credentials: false/);
});

const ARRAY_SHAPE = JSON.stringify([
  { id: "pi-lingua@0.1.0", name: "pi-lingua", files: [{ path: "README.md" }, { path: "lib/a.ts" }] },
]);

// npm 11 prints an array; npm 12 prints an object keyed by package name. The publish job installs
// npm@latest while CI uses the runner's npm, so both shapes reach this code.
const OBJECT_SHAPE = JSON.stringify({
  "pi-lingua": {
    id: "pi-lingua@0.1.0",
    name: "pi-lingua",
    files: [{ path: "README.md" }, { path: "lib/a.ts" }],
  },
});

test("the pack parser accepts the npm 11 array shape", () => {
  const result = parsePackResult(ARRAY_SHAPE, "pi-lingua");
  assert.equal(result.files.length, 2);
});

test("the pack parser accepts the npm 12 object shape", () => {
  const result = parsePackResult(OBJECT_SHAPE, "pi-lingua");
  assert.equal(result.files.length, 2);
});

test("the pack parser ignores output printed before the JSON", () => {
  const result = parsePackResult(`npm notice something\n${OBJECT_SHAPE}\n`, "pi-lingua");
  assert.equal(result.name, "pi-lingua");
});

test("the pack parser rejects an empty or malformed result", () => {
  assert.throws(() => parsePackResult("", "pi-lingua"), /no JSON output/);
  assert.throws(() => parsePackResult("not json", "pi-lingua"), /no JSON output/);
  assert.throws(() => parsePackResult("{ \"a\": 1 }", "pi-lingua"), /no files list/);
  assert.throws(
    () => parsePackResult(JSON.stringify([{ files: [] }, { files: [] }]), "pi-lingua"),
    /exactly one package/,
  );
});
