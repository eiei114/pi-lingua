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

test("the widget compacts long URLs and file paths in the source excerpt only", () => {
  const url = "https://example.com/docs/api/reference/guide?utm_source=a-very-long-tracking-value";
  const path = "C:\\Users\\Keisu\\Projects\\OSS\\pi-lingua\\src\\render\\preview.ts";
  const prompt = `Review ${url}, then open ${path}.`;
  const reviewWithReferences = review({ language: "native", prompt, changes: [] });

  const widget = renderReviewWidget(reviewWithReferences, { explainIn: "native" }).join("\n");
  assert.ok(widget.includes("https://example.com/…/reference/guide?…"));
  assert.ok(widget.includes("…/render/preview.ts"));
  assert.ok(!widget.includes("utm_source"));
  assert.ok(!widget.includes("C:\\Users\\Keisu"));

  const detail = renderReviewDetail(reviewWithReferences);
  assert.ok(detail.includes(url));
  assert.ok(detail.includes(path));
});

test("file paths in original change fragments are compacted in the widget", () => {
  const path = "/Users/keisu/Projects/pi-lingua/src/features/long-file-name.ts";
  const lines = renderReviewWidget(
    review({ changes: [{ from: `Update ${path}`, to: "Update the view" }] }),
    { explainIn: "native" },
  );

  assert.ok(lines.some((line) => line.includes("…/features/long-file-name.ts")));
  assert.ok(!lines.join("\n").includes("/Users/keisu"));
});

test("path compaction never lengthens a path when it cannot omit a segment", () => {
  const path = "/very-long-directory-name/file.ts";
  const lines = renderReviewWidget(
    review({ language: "native", prompt: `Open ${path}`, changes: [] }),
    { explainIn: "native" },
  );

  assert.ok(lines.some((line) => line.includes(path)));
  assert.ok(!lines.join("\n").includes(`…${path}`));
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
