import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const { renderReviewDetail, renderReviewWidget } = await import("../lib/render.ts");

function review(overrides = {}) {
  return {
    prompt: "the bug of login",
    language: "target",
    targetLanguageName: "English",
    targetLanguageTag: "en",
    nativeLanguageName: "Japanese",
    rendering: "Fix the login bug",
    changes: [{ from: "the bug of login", to: "the login bug" }],
    note: "noun の修飾は前置が自然",
    vocabulary: [],
    createdAt: "2026-09-21T09:12:00.000Z",
    ...overrides,
  };
}

test("a target-language review renders a header, the change, and the reason", () => {
  const lines = renderReviewWidget(review(), { explainIn: "native" });
  assert.equal(lines[0], "EN review");
  assert.equal(lines[1], "- the bug of login");
  assert.equal(lines[2], "+ the login bug");
  assert.equal(lines[3], "noun の修飾は前置が自然");
});

test("a native-language review renders the prompt it translated", () => {
  const lines = renderReviewWidget(
    review({ language: "native", prompt: "ログインのバグを直して", changes: [] }),
    { explainIn: "native" },
  );
  assert.equal(lines[0], "JA → EN");
  assert.equal(lines[1], "> ログインのバグを直して");
  assert.equal(lines[2], "+ Fix the login bug");
});

test("a review with no changes is marked as already acceptable", () => {
  const lines = renderReviewWidget(review({ changes: [] }), { explainIn: "native" });
  assert.equal(lines[0], "EN review");
  assert.match(lines[1], /^ok {2}Fix the login bug$/);
});

test("vocabulary is rendered as its own block", () => {
  const lines = renderReviewWidget(
    review({ vocabulary: [{ from: "fix", to: "resolve" }, { from: "bug", to: "defect", gloss: "形式語" }] }),
    { explainIn: "native" },
  );
  assert.ok(lines.includes("◆ vocab"));
  assert.ok(lines.some((line) => line.includes("fix → resolve")));
  assert.ok(lines.some((line) => line.includes("bug → defect") && line.includes("形式語")));
});

test("a short review stays compact", () => {
  const lines = renderReviewWidget(
    review({
      vocabulary: [
        { from: "fix", to: "resolve" },
        { from: "bug", to: "defect" },
      ],
    }),
    { explainIn: "native" },
  );
  assert.ok(lines.length <= 10, `widget rendered ${lines.length} lines`);
});

test("long fragments are wrapped without losing their endings", () => {
  const lines = renderReviewWidget(
    review({ changes: [{ from: "x".repeat(400), to: "y".repeat(400) }] }),
    { explainIn: "native", width: 40 },
  );
  for (const line of lines) {
    assert.ok(line.length <= 41, `line exceeded width: ${line.length}`);
  }
  assert.ok(!lines.join("").includes("…"));
  assert.equal((lines.join("").match(/x/g) ?? []).length, 400);
  assert.equal((lines.join("").match(/y/g) ?? []).length, 400);
});

test("the detail view carries the full review", () => {
  const detail = renderReviewDetail(
    review({ vocabulary: [{ from: "fix", to: "resolve", gloss: "強度" }] }),
  );
  assert.match(detail, /## English review/);
  assert.match(detail, /the bug of login/);
  assert.match(detail, /Fix the login bug/);
  assert.match(detail, /fix → resolve \(強度\)/);
});

test("a one-column terminal is not widened by the renderer", () => {
  const lines = renderReviewWidget(review({ note: "", vocabulary: [] }), { explainIn: "native", width: 1 });
  for (const line of lines) assert.ok(visibleWidth(line) <= 1);
});

test("native examples, notes, and vocabulary retain all text at narrow cell widths", () => {
  const prompt = "日本語の長い例文です".repeat(20);
  const rendering = "TranslatedExample".repeat(20);
  const note = "詳しい説明".repeat(20);
  const from = "OriginalVocabulary".repeat(10);
  const to = "SuggestedVocabulary".repeat(10);
  const gloss = "語彙の意味".repeat(20);
  for (const width of [12, 40, 80]) {
    const lines = renderReviewWidget(review({ language: "native", prompt, rendering, note,
      vocabulary: [{ from, to, gloss }] }), { explainIn: "native", width });
    for (const line of lines) assert.ok(visibleWidth(line) <= width);
    const joined = lines.join("").replace(/\s/g, "");
    for (const text of [prompt, rendering, note, from, to, gloss]) {
      assert.ok(joined.includes(text), `lost content at width ${width}`);
    }
  }
});

test("the detail view states the translation direction for native prompts", () => {
  const detail = renderReviewDetail(review({ language: "native", changes: [] }));
  assert.match(detail, /## Japanese → English/);
});
