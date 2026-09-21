#!/usr/bin/env node
/**
 * Fails when an npm long-lived token is reintroduced anywhere in the release path.
 *
 * Publishing must go through npm Trusted Publishing (OIDC). A stray `NPM_TOKEN` reference makes
 * the publish workflow look configured while it silently depends on a secret that should not
 * exist, so this check is part of `npm run ci`.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const WORKFLOW_DIR = join(ROOT, ".github", "workflows");
const FORBIDDEN = [/NPM_TOKEN/, /NODE_AUTH_TOKEN/, /secrets\.NPM_TOKEN/];

function workflowFiles() {
  if (!existsSync(WORKFLOW_DIR)) return [];
  return readdirSync(WORKFLOW_DIR)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => join(WORKFLOW_DIR, name));
}

const problems = [];
for (const file of workflowFiles()) {
  const content = readFileSync(file, "utf8");
  for (const pattern of FORBIDDEN) {
    if (pattern.test(content)) {
      problems.push(`${relative(ROOT, file)} references ${pattern.source}`);
    }
  }
}

const npmrc = join(ROOT, ".npmrc");
if (existsSync(npmrc)) {
  const content = readFileSync(npmrc, "utf8");
  for (const pattern of FORBIDDEN) {
    if (pattern.test(content)) problems.push(`.npmrc references ${pattern.source}`);
  }
}

assert.deepEqual(
  problems,
  [],
  `publish must use npm Trusted Publishing (OIDC), not a stored token:\n${problems.join("\n")}`,
);

const publishWorkflow = join(WORKFLOW_DIR, "publish.yml");
if (existsSync(publishWorkflow)) {
  const content = readFileSync(publishWorkflow, "utf8");
  assert.match(content, /id-token:\s*write/, "publish.yml must request id-token: write for OIDC");
}

console.log("publish:guard OK — no stored npm token in the release path.");
