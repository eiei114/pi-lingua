import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Pi's agent directory is redirected before any settings path is resolved, so these tests never
// touch the machine's real `~/.pi/agent/settings.json`.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-lingua-agent-"));

const {
  declaresLinguaKey,
  displaySettingsPath,
  hasProjectSettings,
  linguaKeyOwner,
  readSettingsFile,
  settingsFilePath,
  writeLinguaSettings,
} = await import("../lib/settings.ts");
const { loadLinguaConfig } = await import("../lib/config.ts");

function tempProject(label) {
  return mkdtempSync(join(tmpdir(), `pi-lingua-${label}-`));
}

function writeSettings(filePath, settings) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function options(cwd, overrides = {}) {
  return { cwd, projectWritesAllowed: true, ...overrides };
}

// Every test starts from an empty agent settings file; the directory is shared for the whole file.
test.beforeEach(() => {
  const globalPath = join(process.env.PI_CODING_AGENT_DIR, "settings.json");
  if (existsSync(globalPath)) rmSync(globalPath);
});

test("a key no file sets lands in the global settings file", () => {
  const cwd = tempProject("global");
  const writes = writeLinguaSettings([{ keyPath: "enabled", value: false }], options(cwd));

  assert.equal(writes.length, 1);
  assert.equal(writes[0].scope, "global");
  assert.deepEqual(writes[0].applied, ["enabled"]);
  assert.equal(writes[0].shadowed, false);
  assert.deepEqual(readSettingsFile(settingsFilePath("global", cwd)), {
    "pi-lingua": { enabled: false },
  });
  assert.equal(loadLinguaConfig(cwd).enabled, false, "the next session reads the saved value");
});

test("writing keeps every other key in the settings file", () => {
  const cwd = tempProject("preserve");
  const globalPath = settingsFilePath("global", cwd);
  writeSettings(globalPath, { theme: "dark", "pi-lingua": { targetLanguage: "fr" } });

  writeLinguaSettings([{ keyPath: "enabled", value: false }], options(cwd));

  const document = readSettingsFile(globalPath);
  assert.equal(document.theme, "dark");
  assert.deepEqual(document["pi-lingua"], { targetLanguage: "fr", enabled: false });
});

test("commands write globally without changing legacy project keys", () => {
  const cwd = tempProject("owner");
  const projectPath = settingsFilePath("project", cwd);
  writeSettings(projectPath, { "pi-lingua": { enabled: true } });

  const writes = writeLinguaSettings([{ keyPath: "enabled", value: false }], options(cwd));

  assert.equal(writes[0].scope, "global");
  assert.deepEqual(readSettingsFile(projectPath), { "pi-lingua": { enabled: true } });
  assert.equal(readSettingsFile(settingsFilePath("global", cwd))["pi-lingua"].enabled, false);
  assert.equal(loadLinguaConfig(cwd).enabled, false);
});

test("untrusted project blocks are neither written nor allowed to shadow global settings", () => {
  const cwd = tempProject("untrusted");
  writeSettings(settingsFilePath("project", cwd), { "pi-lingua": { enabled: true } });

  const writes = writeLinguaSettings(
    [{ keyPath: "enabled", value: false }],
    options(cwd, { projectWritesAllowed: false }),
  );

  assert.equal(writes[0].scope, "global");
  assert.equal(writes[0].shadowed, false, "project blocks never shadow global Lingua settings");
  assert.deepEqual(readSettingsFile(settingsFilePath("project", cwd)), {
    "pi-lingua": { enabled: true },
  });
});

test("removing the last key removes the block instead of leaving an empty object", () => {
  const cwd = tempProject("prune");
  const globalPath = settingsFilePath("global", cwd);
  writeSettings(globalPath, {
    theme: "dark",
    "pi-lingua": { reviewer: { provider: "p", model: "m" }, minWords: 4 },
  });

  const writes = writeLinguaSettings(
    [
      { keyPath: "reviewer.provider", value: undefined, targets: "all" },
      { keyPath: "reviewer.model", value: undefined, targets: "all" },
      { keyPath: "minWords", value: undefined, targets: "all" },
    ],
    options(cwd),
  );

  assert.deepEqual(writes[0].removed, ["reviewer.provider", "reviewer.model", "minWords"]);
  assert.deepEqual(readSettingsFile(globalPath), { theme: "dark" });
});

test("removing a value only changes the global file", () => {
  const cwd = tempProject("all");
  writeSettings(settingsFilePath("global", cwd), { "pi-lingua": { reviewer: { model: "m" } } });
  writeSettings(settingsFilePath("project", cwd), { "pi-lingua": { reviewer: { model: "m" } } });

  const writes = writeLinguaSettings(
    [{ keyPath: "reviewer.model", value: undefined, targets: "all" }],
    options(cwd),
  );

  assert.deepEqual(writes.map((write) => write.scope).sort(), ["global"]);
  assert.deepEqual(readSettingsFile(settingsFilePath("global", cwd)), {});
  assert.deepEqual(readSettingsFile(settingsFilePath("project", cwd)), { "pi-lingua": { reviewer: { model: "m" } } });
});

test("a value that is already set is left alone", () => {
  const cwd = tempProject("noop");
  const globalPath = settingsFilePath("global", cwd);
  writeSettings(globalPath, { "pi-lingua": { enabled: false } });
  const before = readFileSync(globalPath, "utf8");

  const writes = writeLinguaSettings([{ keyPath: "enabled", value: false }], options(cwd));

  assert.deepEqual(writes, []);
  assert.equal(readFileSync(globalPath, "utf8"), before);
});

test("linguaKeyOwner names the file that decides a key", () => {
  const cwd = tempProject("owner-lookup");
  assert.equal(linguaKeyOwner(cwd, "enabled"), undefined);

  writeSettings(settingsFilePath("global", cwd), { "pi-lingua": { enabled: true } });
  assert.equal(linguaKeyOwner(cwd, "enabled"), "global");

  writeSettings(settingsFilePath("project", cwd), { "pi-lingua": { enabled: false } });
  assert.equal(linguaKeyOwner(cwd, "enabled"), "global");
  assert.equal(hasProjectSettings(cwd), true);
});

test("declaresLinguaKey only matches a complete key path", () => {
  const document = { "pi-lingua": { reviewer: { provider: "p" } } };
  assert.equal(declaresLinguaKey(document, "reviewer"), true);
  assert.equal(declaresLinguaKey(document, "reviewer.provider"), true);
  assert.equal(declaresLinguaKey(document, "reviewer.model"), false);
  assert.equal(declaresLinguaKey(document, "enabled"), false);
  assert.equal(declaresLinguaKey(undefined, "enabled"), false);
});

test("paths are reported the way a reader would type them", () => {
  const cwd = tempProject("display");
  assert.equal(displaySettingsPath("project", cwd), ".pi/settings.json");
  assert.match(displaySettingsPath("global", cwd), /settings\.json$/);
});

test("a settings file that is not valid JSON is never overwritten", () => {
  const cwd = tempProject("malformed");
  const globalPath = settingsFilePath("global", cwd);
  writeFileSync(globalPath, "{ not json", "utf8");

  assert.throws(
    () => writeLinguaSettings([{ keyPath: "enabled", value: false }], options(cwd)),
    /is not a JSON object|JSON/,
  );
  assert.equal(readFileSync(globalPath, "utf8"), "{ not json");
});
