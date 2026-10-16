import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const currentVersion = packageJson.version;
const tags = execFileSync(
  "git",
  ["tag", "--list", "v[0-9]*", "--sort=-version:refname"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .filter(Boolean);
const currentTag = `v${currentVersion}`;
const latestTag = tags[0] ?? null;
const latestReleasedVersion = latestTag?.slice(1) ?? null;

let result;
if (tags.includes(currentTag)) {
  result = { released: false, message: `Tag ${currentTag} already exists; skipping.` };
} else if (currentVersion === latestReleasedVersion) {
  result = { released: false, message: `Version ${currentVersion} is already released; skipping.` };
} else {
  result = {
    released: true,
    tag: currentTag,
    message: `Version not yet released: ${latestReleasedVersion ?? "none"} -> ${currentVersion}.`,
  };
}

console.log(result.message);
const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error("GITHUB_OUTPUT is required to report the release decision.");
appendFileSync(outputPath, `released=${result.released}\n`);
if (result.released) appendFileSync(outputPath, `tag=${result.tag}\n`);
