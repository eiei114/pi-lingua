import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultConfig } from "../lib/config.ts";
import { buildReviewerPrompt, parseReviewResponse } from "../lib/review.ts";
import { renderReviewWidget, renderReviewDetail } from "../lib/render.ts";
import { renderReviewLogSection } from "../lib/sinks/markdown-log.ts";

const speaking = { chunked: "Fix / the bug", ipa: "fɪks / ðə bʌɡ", kana: "フィクス / ザ バグ" };
function parse(nativeLanguage = "ja", guide = speaking) {
  return parseReviewResponse(JSON.stringify({ rendering: "Fix the bug", speaking: guide }), {
    prompt: "バグを直して", language: "native", config: { ...createDefaultConfig(), nativeLanguage },
  });
}

test("Japanese native aliases receive kana alongside IPA independently of explanation language", () => {
  for (const nativeLanguage of ["ja", "ja-JP", "Japanese"]) {
    assert.deepEqual(parse(nativeLanguage).speaking, speaking);
    const prompt = buildReviewerPrompt({ text: "Fix the bug", language: "target",
      config: { ...createDefaultConfig(), nativeLanguage, explainIn: "target" } });
    assert.match(prompt.systemPrompt, /IPA is still required/);
  }
});

test("other native languages keep IPA but discard volunteered kana", () => {
  assert.deepEqual(parse("fr").speaking, { chunked: speaking.chunked, ipa: speaking.ipa });
  const prompt = buildReviewerPrompt({ text: "Fix the bug", language: "target",
    config: { ...createDefaultConfig(), nativeLanguage: "fr" } });
  assert.match(prompt.systemPrompt, /omit `kana`/);
});

test("legacy, malformed, incomplete, mismatched, and oversized guides do not break reviews", () => {
  for (const guide of [null, [], "bad", {}, { ...speaking, ipa: 3 },
    { ...speaking, chunked: "Fix / something else" }, { ...speaking, ipa: "a".repeat(12001) }]) {
    const review = parse("ja", guide);
    assert.equal(review.rendering, "Fix the bug");
    assert.equal(review.speaking, undefined);
  }
});

test("all text views preserve pronunciation and speaking pauses", () => {
  const review = parse();
  for (const output of [renderReviewWidget(review, { explainIn: "native", width: 80 }).join("\n"),
    renderReviewDetail(review), renderReviewLogSection(review)]) {
    for (const value of Object.values(speaking)) assert.ok(output.includes(value));
  }
  const narrow = renderReviewWidget(review, { explainIn: "native", width: 12 }).join("").replace(/\s/g, "");
  assert.ok(narrow.includes(speaking.kana.replace(/\s/g, "")));
});
