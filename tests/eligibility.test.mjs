import assert from "node:assert/strict";
import test from "node:test";

const { buildProseText, evaluateEligibility, measureProse, stripNonProse } = await import(
  "../lib/eligibility.ts"
);
const { createDefaultConfig } = await import("../lib/config.ts");

const config = createDefaultConfig();

function evaluate(text, overrides = {}) {
  return evaluateEligibility(text, { ...config, ...overrides });
}

test("empty input is skipped", () => {
  const result = evaluate("   ");
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "empty");
});

test("slash commands are skipped before expansion happens", () => {
  for (const text of ["/lingua:off", "/skill:grilling please grill me", "/template foo"]) {
    const result = evaluate(text);
    assert.equal(result.eligible, false, text);
    assert.equal(result.reason, "command");
  }
});

test("short replies are skipped", () => {
  for (const text of ["ok", "yes", "continue", "looks good"]) {
    const result = evaluate(text);
    assert.equal(result.eligible, false, text);
    assert.equal(result.reason, "too-short");
  }
});

test("the minimum length is a floor, so a three-word acknowledgement still qualifies", () => {
  // Default minWords is 3. "yes, do it" is exactly 3 words, so it is eligible by the rule even
  // though it is unlikely to teach anything. Raise minWords to suppress short directives.
  const result = evaluate("yes, do it");
  assert.equal(result.eligible, true);
  assert.equal(evaluate("yes, do it", { minWords: 4 }).reason, "too-short");
});

test("a Japanese prompt shorter than the character minimum is skipped", () => {
  const result = evaluate("はい");
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "too-short");
});

test("code-only input is skipped", () => {
  const result = evaluate("```ts\nconst value = compute(input);\n```");
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "code");
});

test("an English prompt is eligible and classified as the target language", () => {
  const result = evaluate("fix the bug of login");
  assert.equal(result.eligible, true);
  assert.equal(result.language, "target");
  assert.equal(result.reason, "eligible");
});

test("a Japanese prompt is eligible and classified as the native language", () => {
  const result = evaluate("ログインのバグを直して");
  assert.equal(result.eligible, true);
  assert.equal(result.language, "native");
});

test("a mixed prompt follows its dominant script", () => {
  const japanese = evaluate("npm の install が 失敗するので 直して ほしい");
  assert.equal(japanese.language, "native");

  const english = evaluate("the install step in package.json keeps failing on windows machines");
  assert.equal(english.language, "target");
});

test("native-language prompts can be turned off", () => {
  const result = evaluate("ログインのバグを直して", { reviewNativeLanguagePrompts: false });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "native-prompts-disabled");
  assert.equal(result.language, "native");
});

test("an unrecognized language setting is reported instead of guessed", () => {
  const result = evaluate("fix the bug", { targetLanguage: "klingon" });
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "unknown-language");
  assert.match(result.detail, /klingon/);
});

test("a prompt in a third script is skipped as unknown", () => {
  const result = evaluate("исправить ошибку входа в систему");
  assert.equal(result.eligible, false);
  assert.equal(result.reason, "unknown-language");
});

test("minimum length is configurable and applies per language unit", () => {
  assert.equal(evaluate("fix login", { minWords: 5 }).reason, "too-short");
  assert.equal(evaluate("fix login", { minWords: 2 }).eligible, true);
  assert.equal(evaluate("修正して", { minChars: 10 }).reason, "too-short");
  assert.equal(evaluate("修正して", { minChars: 3 }).eligible, true);
});

test("stripNonProse removes fences, inline code, and URLs", () => {
  const stripped = stripNonProse("see `config.ts` at https://example.com/a ```js\nlet x = 1;\n``` now");
  assert.doesNotMatch(stripped, /config\.ts/);
  assert.doesNotMatch(stripped, /example\.com/);
  assert.doesNotMatch(stripped, /let x/);
  assert.match(stripped, /^see\s+at\s+now$/);
});

test("buildProseText keeps prose that surrounds a code block", () => {
  const prose = buildProseText("please fix\nthe login flow\n```ts\nconst a = 1;\n```");
  assert.match(prose, /please fix/);
  assert.match(prose, /login flow/);
  assert.doesNotMatch(prose, /const a/);
});

test("measureProse reports both words and scripted characters", () => {
  assert.deepEqual(measureProse("fix the login bug"), { words: 4, characters: 14 });
  assert.deepEqual(measureProse("ログインのバグ"), { words: 1, characters: 7 });
});
