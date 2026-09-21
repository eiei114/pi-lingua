import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { applyOverrides, createDefaultConfig, expandHome, loadLinguaConfig, defaultReviewLogDir } =
  await import("../lib/config.ts");

function writeSettings(cwd, settings) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(settings), "utf8");
}

test("the default review log lives under Pi's own agent directory", () => {
  assert.match(defaultReviewLogDir().replaceAll("\\", "/"), /lingua\/reviews$/);
});

test("defaults work with no configuration at all", () => {
  const config = createDefaultConfig();
  assert.equal(config.targetLanguage, "en");
  assert.equal(config.nativeLanguage, "ja");
  assert.equal(config.explainIn, "native");
  assert.equal(config.minWords, 3);
  assert.equal(config.sinks.reviewLog.enabled, true);
  assert.equal(config.sinks.anki.enabled, false);
});

test("applyOverrides keeps defaults for keys the settings block omits", () => {
  const config = applyOverrides(createDefaultConfig(), { targetLanguage: "fr" });
  assert.equal(config.targetLanguage, "fr");
  assert.equal(config.nativeLanguage, "ja");
  assert.equal(config.sinks.reviewLog.enabled, true);
});

test("applyOverrides ignores wrong types instead of throwing", () => {
  const config = applyOverrides(createDefaultConfig(), {
    minWords: "three",
    minChars: "six",
    explainIn: "sideways",
    reviewNativeLanguagePrompts: "yes",
  });
  assert.equal(config.minWords, 3);
  assert.equal(config.minChars, 6);
  assert.equal(config.explainIn, "native");
  assert.equal(config.reviewNativeLanguagePrompts, true);
});

test("applyOverrides ignores non-object input", () => {
  const base = createDefaultConfig();
  assert.deepEqual(applyOverrides(base, undefined), base);
  assert.deepEqual(applyOverrides(base, "nope"), base);
  assert.deepEqual(applyOverrides(base, []), base);
});

test("applyOverrides clamps a non-positive minimum length", () => {
  assert.equal(applyOverrides(createDefaultConfig(), { minWords: 0 }).minWords, 3);
  assert.equal(applyOverrides(createDefaultConfig(), { minWords: -4 }).minWords, 3);
});

test("sink settings merge field by field", () => {
  const config = applyOverrides(createDefaultConfig(), {
    sinks: { anki: { enabled: true, mode: "tsv" } },
  });
  assert.equal(config.sinks.anki.enabled, true);
  assert.equal(config.sinks.anki.mode, "tsv");
  assert.equal(config.sinks.anki.deck, "English::PromptReview");
  assert.equal(config.sinks.anki.endpoint, "http://127.0.0.1:8765");
});

test("project settings win over the defaults", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lingua-config-"));
  writeSettings(cwd, {
    "pi-lingua": { targetLanguage: "fr", sinks: { reviewLog: { dir: "notes/lingua" } } },
  });

  const config = loadLinguaConfig(cwd);
  assert.equal(config.targetLanguage, "fr");
  assert.equal(config.sinks.reviewLog.dir, "notes/lingua");
  assert.equal(config.nativeLanguage, "ja");
});

test("a malformed settings file falls back to defaults", () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lingua-bad-"));
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "settings.json"), "{ not json", "utf8");

  const config = loadLinguaConfig(cwd);
  assert.equal(config.targetLanguage, "en");
});

test("expandHome resolves the leading tilde forms users write in settings", () => {
  assert.equal(expandHome("~/reviews", "/home/u"), join("/home/u", "reviews"));
  assert.equal(expandHome("~", "/home/u"), "/home/u");
  assert.equal(expandHome("/absolute/path", "/home/u"), "/absolute/path");
  assert.equal(expandHome("relative/path", "/home/u"), "relative/path");
});
