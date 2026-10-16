import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const checkerPath = fileURLToPath(new URL("../scripts/check-release-version.mjs", import.meta.url));

function git(repository, ...args) {
  return execFileSync("git", args, { cwd: repository, stdio: "ignore" });
}

function writePackageVersion(repository, version) {
  writeFileSync(join(repository, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
}

function createReleaseRepository() {
  const repository = mkdtempSync(join(tmpdir(), "pi-lingua-release-check-"));
  git(repository, "init", "--quiet");
  git(repository, "checkout", "-b", "main");
  git(repository, "config", "user.name", "Release test");
  git(repository, "config", "user.email", "release-test@example.invalid");

  writePackageVersion(repository, "0.6.1");
  git(repository, "add", "package.json");
  git(repository, "commit", "--quiet", "-m", "release 0.6.1");
  git(repository, "tag", "v0.6.1");

  writePackageVersion(repository, "0.6.2");
  git(repository, "add", "package.json");
  git(repository, "commit", "--quiet", "-m", "bump package version");
  writeFileSync(join(repository, "README.md"), "A later commit without a version change.\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "--quiet", "-m", "follow-up change");
  return repository;
}

function runReleaseCheck(repository) {
  const outputPath = join(repository, "github-output");
  execFileSync(process.execPath, [checkerPath], {
    cwd: repository,
    env: { ...process.env, GITHUB_OUTPUT: outputPath },
    encoding: "utf8",
  });
  return readFileSync(outputPath, "utf8");
}

test("release check finds an untagged version after a follow-up commit", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository, { recursive: true, force: true }));

  const currentVersion = JSON.parse(execFileSync("git", ["show", "HEAD:package.json"], { cwd: repository }));
  const parentVersion = JSON.parse(execFileSync("git", ["show", "HEAD^:package.json"], { cwd: repository }));
  assert.equal(currentVersion.version, "0.6.2");
  assert.equal(parentVersion.version, currentVersion.version);
  assert.equal(execFileSync("git", ["tag", "--list", "v0.6.2"], { cwd: repository, encoding: "utf8" }).trim(), "");

  const output = runReleaseCheck(repository);
  assert.match(output, /^released=true$/m);
  assert.match(output, /^tag=v0\.6\.2$/m);
});

test("release check still skips a version whose tag already exists", (t) => {
  const repository = createReleaseRepository();
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  git(repository, "tag", "v0.6.2");

  const output = runReleaseCheck(repository);
  assert.match(output, /^released=false$/m);
  assert.doesNotMatch(output, /^tag=/m);
});
