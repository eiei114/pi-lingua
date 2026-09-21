import assert from "node:assert/strict";
import test from "node:test";

const { classifyScriptCharacter, countScripts, dominantScript, resolveLanguage, LANGUAGES } = await import(
  "../lib/languages.ts"
);

test("resolveLanguage accepts tags, names, and region subtags", () => {
  assert.equal(resolveLanguage("en")?.tag, "en");
  assert.equal(resolveLanguage("EN")?.tag, "en");
  assert.equal(resolveLanguage("English")?.tag, "en");
  assert.equal(resolveLanguage(" english ")?.tag, "en");
  assert.equal(resolveLanguage("ja")?.tag, "ja");
  assert.equal(resolveLanguage("Japanese")?.tag, "ja");
  assert.equal(resolveLanguage("en-GB")?.tag, "en");
  assert.equal(resolveLanguage("zh-Hans")?.tag, "zh");
});

test("resolveLanguage returns undefined for unknown input so callers can report it", () => {
  assert.equal(resolveLanguage("klingon"), undefined);
  assert.equal(resolveLanguage(""), undefined);
  assert.equal(resolveLanguage("   "), undefined);
});

test("every language definition carries a name, scripts, and a length unit", () => {
  for (const [tag, definition] of Object.entries(LANGUAGES)) {
    assert.ok(definition.name.length > 0, `${tag} needs a display name`);
    assert.ok(definition.scripts.length > 0, `${tag} needs at least one script`);
    assert.equal(typeof definition.spaceDelimited, "boolean", `${tag} needs spaceDelimited`);
  }
});

test("classifyScriptCharacter maps the ranges the classifier depends on", () => {
  assert.equal(classifyScriptCharacter("a".codePointAt(0)), "latin");
  assert.equal(classifyScriptCharacter("Z".codePointAt(0)), "latin");
  assert.equal(classifyScriptCharacter("あ".codePointAt(0)), "kana");
  assert.equal(classifyScriptCharacter("ア".codePointAt(0)), "kana");
  assert.equal(classifyScriptCharacter("漢".codePointAt(0)), "han");
  assert.equal(classifyScriptCharacter("한".codePointAt(0)), "hangul");
  assert.equal(classifyScriptCharacter("д".codePointAt(0)), "cyrillic");
  assert.equal(classifyScriptCharacter("α".codePointAt(0)), "greek");
  assert.equal(classifyScriptCharacter("あ".codePointAt(0)), "kana");
});

test("classifyScriptCharacter ignores digits, punctuation, and whitespace", () => {
  assert.equal(classifyScriptCharacter("7".codePointAt(0)), undefined);
  assert.equal(classifyScriptCharacter(" ".codePointAt(0)), undefined);
  assert.equal(classifyScriptCharacter("!".codePointAt(0)), undefined);
  assert.equal(classifyScriptCharacter("。".codePointAt(0)), undefined);
});

test("dominantScript picks the script covering the most characters", () => {
  assert.equal(dominantScript("fix the bug"), "latin");
  assert.equal(dominantScript("ログインのバグを直して"), "kana");
  assert.equal(dominantScript("バグを修正"), "kana");
  assert.equal(dominantScript("漢字だけの文"), "han");
  assert.equal(dominantScript("123 456"), undefined);
});

test("countScripts counts each script separately in mixed text", () => {
  const counts = countScripts("npm で install する");
  assert.equal(counts.get("latin"), "npminstall".length);
  assert.ok((counts.get("kana") ?? 0) > 0);
});
