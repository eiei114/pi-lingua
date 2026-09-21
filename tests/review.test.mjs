import assert from "node:assert/strict";
import test from "node:test";

const { extractAssistantText, extractJsonObject, parseReviewResponse, buildReviewerPrompt } =
  await import("../lib/review.ts");
const { createDefaultConfig } = await import("../lib/config.ts");

const config = createDefaultConfig();

test("extractJsonObject reads a bare JSON object", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
});

test("extractJsonObject strips a code fence", () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
});

test("extractJsonObject ignores surrounding model chatter", () => {
  const raw = 'Sure! Here is the review:\n{"a":1}\nLet me know if that helps.';
  assert.equal(extractJsonObject(raw), '{"a":1}');
});

test("extractJsonObject is not confused by braces inside strings", () => {
  const raw = '{"rendering":"use {braces} carefully","note":"x"}';
  assert.equal(extractJsonObject(raw), raw);
});

test("extractJsonObject returns undefined when there is no object", () => {
  assert.equal(extractJsonObject("no json here"), undefined);
  assert.equal(extractJsonObject('{"unterminated": '), undefined);
});

test("parseReviewResponse normalizes a well-formed response", () => {
  const raw = JSON.stringify({
    rendering: "Fix the login bug",
    changes: [{ from: "the bug of login", to: "the login bug" }],
    note: "noun の修飾は前置が自然",
    vocabulary: [{ from: "fix", to: "resolve", gloss: "強度" }],
  });

  const review = parseReviewResponse(raw, {
    prompt: "the bug of login",
    language: "target",
    config,
    createdAt: "2026-09-21T00:00:00.000Z",
  });

  assert.equal(review.rendering, "Fix the login bug");
  assert.equal(review.changes.length, 1);
  assert.equal(review.vocabulary[0].to, "resolve");
  assert.equal(review.targetLanguageName, "English");
  assert.equal(review.targetLanguageTag, "en");
  assert.equal(review.nativeLanguageName, "Japanese");
  assert.equal(review.prompt, "the bug of login");
});

test("parseReviewResponse rejects a response without a rendering", () => {
  const review = parseReviewResponse('{"note":"missing rendering"}', {
    prompt: "x",
    language: "target",
    config,
  });
  assert.equal(review, undefined);
});

test("parseReviewResponse rejects unparseable output", () => {
  const review = parseReviewResponse("I could not review this.", {
    prompt: "x",
    language: "target",
    config,
  });
  assert.equal(review, undefined);
});

test("parseReviewResponse clamps changes and vocabulary to the display budget", () => {
  const raw = JSON.stringify({
    rendering: "ok",
    changes: [
      { from: "a", to: "b" },
      { from: "c", to: "d" },
      { from: "e", to: "f" },
    ],
    vocabulary: [
      { from: "1", to: "2" },
      { from: "3", to: "4" },
      { from: "5", to: "6" },
    ],
  });
  const review = parseReviewResponse(raw, { prompt: "x", language: "target", config });
  assert.equal(review.changes.length, 2);
  assert.equal(review.vocabulary.length, 2);
});

test("parseReviewResponse tolerates missing optional fields", () => {
  const review = parseReviewResponse('{"rendering":"Fix it"}', {
    prompt: "x",
    language: "target",
    config,
  });
  assert.deepEqual(review.changes, []);
  assert.deepEqual(review.vocabulary, []);
  assert.equal(review.note, "");
});

test("the reviewer prompt names the direction and forbids changing intent", () => {
  const target = buildReviewerPrompt({ text: "the bug of login", language: "target", config });
  assert.match(target.systemPrompt, /written in English/);
  assert.match(target.systemPrompt, /Never add, remove, or reinterpret a requirement/);
  assert.match(target.systemPrompt, /JSON only/);
  assert.equal(target.userPrompt, "the bug of login");
});

test("the reviewer prompt switches direction for native-language prompts", () => {
  const native = buildReviewerPrompt({
    text: "ログインのバグを直して",
    language: "native",
    config,
  });
  assert.match(native.systemPrompt, /written in Japanese/);
  assert.match(native.systemPrompt, /Produce the English version/);
});

test("the explanation language follows the explainIn setting", () => {
  const native = buildReviewerPrompt({ text: "x", language: "target", config });
  assert.match(native.systemPrompt, /`note` MUST be written in Japanese/);
  assert.match(native.systemPrompt, /one short sentence, written in Japanese/);

  const target = buildReviewerPrompt({
    text: "x",
    language: "target",
    config: { ...config, explainIn: "target" },
  });
  assert.match(target.systemPrompt, /`note` MUST be written in English/);
  assert.doesNotMatch(target.systemPrompt, /MUST be written in Japanese/);
});

test("the reviewer prompt requires changes to quote the input verbatim", () => {
  const prompt = buildReviewerPrompt({ text: "x", language: "target", config });
  assert.match(prompt.systemPrompt, /literally appears in the input/);
});

test("the reviewer prompt forbids diffing a translation against its source", () => {
  const native = buildReviewerPrompt({ text: "x", language: "native", config });
  assert.match(native.systemPrompt, /Return an empty `changes` list/);
  assert.match(native.systemPrompt, /error to list the translation itself as a change/);

  const target = buildReviewerPrompt({ text: "x", language: "target", config });
  assert.doesNotMatch(target.systemPrompt, /Return an empty `changes` list/);
});

test("the reviewer prompt asks the note to teach rather than narrate", () => {
  const prompt = buildReviewerPrompt({ text: "x", language: "target", config });
  assert.match(prompt.systemPrompt, /Do not narrate what you did/);
  assert.match(prompt.systemPrompt, /動詞で始めると指示が明確になる/);
});

test("extractAssistantText joins text blocks and skips thinking", () => {
  const text = extractAssistantText({
    content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: '{"rendering":"ok"}' },
    ],
  });
  assert.equal(text, '{"rendering":"ok"}');
});
