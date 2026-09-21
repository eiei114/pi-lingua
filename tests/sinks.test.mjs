import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createDefaultConfig } = await import("../lib/config.ts");
const {
  localDateKey,
  localTimeLabel,
  markdownLogSink,
  renderReviewLogSection,
  reviewLogPath,
} = await import("../lib/sinks/markdown-log.ts");
const { ankiSink, buildAnkiNote, probeAnkiConnect, renderAnkiTsvRows } = await import(
  "../lib/sinks/anki.ts"
);
const { formatSinkResults, runSinks } = await import("../lib/sinks/dispatch.ts");

function review(overrides = {}) {
  return {
    prompt: "ログインのバグを直して",
    language: "native",
    targetLanguageName: "English",
    targetLanguageTag: "en",
    nativeLanguageName: "Japanese",
    rendering: "Fix the login bug",
    changes: [],
    note: "動詞で始めると指示が明確",
    vocabulary: [{ from: "fix", to: "resolve", gloss: "強度" }],
    createdAt: "2026-09-21T09:12:00.000Z",
    ...overrides,
  };
}

function tempConfig(reviewLogDir) {
  const config = createDefaultConfig();
  config.sinks.reviewLog.dir = reviewLogDir;
  config.sinks.anki.tsvPath = join(reviewLogDir, "anki-cards.tsv");
  return config;
}

test("the log file is keyed by local date", () => {
  assert.equal(localDateKey("2026-09-21T09:12:00.000Z"), "2026-09-21");
  assert.equal(localDateKey("not-a-date"), "unknown-date");
});

test("the time label is zero padded and falls back", () => {
  assert.match(localTimeLabel("2026-09-21T09:12:00.000Z"), /^\d{2}:\d{2}$/);
  assert.equal(localTimeLabel("not-a-date"), "--:--");
});

test("a native-language review has nothing to diff, so no changes block is written", () => {
  const section = renderReviewLogSection(
    review({ language: "native", changes: [{ from: "whole", to: "sentence" }] }),
  );
  assert.doesNotMatch(section, /changes:/);
  assert.doesNotMatch(section, /whole/);
});

test("a target-language review keeps its changes block", () => {
  const section = renderReviewLogSection(
    review({ language: "target", changes: [{ from: "the bug of login", to: "the login bug" }] }),
  );
  assert.match(section, /\*\*changes:\*\*/);
  assert.match(section, /`the bug of login` → `the login bug`/);
});

test("consecutive sections are separated by a blank line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-sep-"));
  const config = tempConfig(dir);

  await markdownLogSink.write(review(), config);
  const second = await markdownLogSink.write(
    review({ language: "target", prompt: "the bug of login", createdAt: "2026-09-21T10:30:00.000Z" }),
    config,
  );

  const content = readFileSync(second.path, "utf8");
  assert.equal(content.match(/^## /gm).length, 2);
  assert.doesNotMatch(content, /[^\n]\n## /, "a section heading must not directly follow the previous line");
});

test("the section states what was written and the target rendering", () => {
  const section = renderReviewLogSection(review());
  assert.match(section, /## \d{2}:\d{2} · Japanese → English/);
  assert.match(section, /\*\*wrote:\*\* ログインのバグを直して/);
  assert.match(section, /\*\*English:\*\* Fix the login bug/);
  assert.match(section, /fix → resolve \(強度\)/);
});

test("the markdown-log sink creates the directory and writes a header once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-log-"));
  const target = join(dir, "nested", "reviews");
  const config = tempConfig(target);

  const first = await markdownLogSink.write(review(), config);
  assert.equal(first.status, "written");

  const second = await markdownLogSink.write(
    review({ createdAt: "2026-09-21T10:30:00.000Z", prompt: "second" }),
    config,
  );
  assert.equal(second.status, "written");
  assert.equal(second.path, first.path);

  const content = readFileSync(first.path, "utf8");
  assert.match(content, /^---\ndate: \d{4}-\d{2}-\d{2}[\s\S]*?\n---\n\n## /, "frontmatter must be closed and followed by a blank line");
  assert.equal(content.match(/target_language:/g).length, 1, "frontmatter must be written once");
  assert.equal(content.match(/^## /gm).length, 2);
  assert.match(content, /second/);
});

test("a log file left empty by an interrupted write gets its header back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-empty-"));
  const config = tempConfig(dir);
  const path = reviewLogPath(config, review());
  writeFileSync(path, "", "utf8");

  const result = await markdownLogSink.write(review(), config);
  assert.equal(result.status, "written");
  assert.match(readFileSync(path, "utf8"), /^---\n/, "an empty file must be re-created with frontmatter");
});

test("the markdown-log sink reports a failure instead of writing somewhere else", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-blocked-"));
  const fileAsDir = join(dir, "not-a-directory");
  writeFileSync(fileAsDir, "occupied", "utf8");

  const result = await markdownLogSink.write(review(), tempConfig(fileAsDir));
  assert.equal(result.status, "failed");
  assert.match(result.detail, /not-a-directory/);
});

test("reviewLogPath resolves a leading tilde", () => {
  const config = tempConfig("~/lingua");
  const path = reviewLogPath(config, review());
  assert.doesNotMatch(path, /~/);
  assert.match(path.replaceAll("\\", "/"), /lingua\/2026-09-21\.md$/);
});

test("the anki sink is manual-only so decks never fill up on their own", () => {
  assert.equal(ankiSink.trigger, "manual");
  assert.equal(markdownLogSink.trigger, "auto");
});

test("an automatic run only touches automatic sinks", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-auto-"));
  const config = tempConfig(dir);
  config.sinks.anki.enabled = true;

  const results = await runSinks(review(), config, "auto");
  assert.deepEqual(results.map((result) => result.sinkId), ["markdown-log"]);
});

test("the anki sink is skipped when the review suggests no vocabulary", async () => {
  const config = tempConfig(mkdtempSync(join(tmpdir(), "pi-lingua-novocab-")));
  config.sinks.anki.enabled = true;
  const result = await ankiSink.write(review({ vocabulary: [] }), config);
  assert.equal(result.status, "skipped");
});

test("TSV rows carry front, back, tags, and deck", () => {
  const rows = renderAnkiTsvRows(review(), "English::PromptReview");
  const [front, rest] = [rows.split("\t")[0], rows];
  assert.equal(front, "fix");
  assert.match(rest, /resolve \(強度\)/);
  assert.match(rest, /pi-lingua/);
  assert.match(rest, /English::PromptReview/);
});

test("the anki note payload targets the configured deck", () => {
  const note = buildAnkiNote({ from: "fix", to: "resolve", gloss: "強度" }, review(), "Deck::X");
  assert.equal(note.action, "addNote");
  assert.equal(note.version, 6);
  assert.equal(note.params.note.deckName, "Deck::X");
  assert.deepEqual(note.params.note.fields, { Front: "fix", Back: "resolve — 強度" });
});

test("AnkiConnect probe failure is reported rather than thrown", async () => {
  const result = await probeAnkiConnect("http://127.0.0.1:1/unreachable");
  assert.equal(result.ok, false);
  assert.ok(result.detail.length > 0);
});

test("the anki sink falls back to TSV and says why when AnkiConnect is absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-anki-"));
  const config = tempConfig(dir);
  config.sinks.anki.enabled = true;
  config.sinks.anki.mode = "ankiconnect";
  config.sinks.anki.endpoint = "http://127.0.0.1:1/unreachable";

  const result = await ankiSink.write(review(), config);
  assert.equal(result.status, "written");
  assert.match(result.detail, /AnkiConnect did not answer/);
  assert.match(readFileSync(result.path, "utf8"), /fix\t/);
});

test("formatSinkResults reports status, path, and detail on one line each", () => {
  const text = formatSinkResults([
    { sinkId: "markdown-log", status: "written", path: "/tmp/a.md" },
    { sinkId: "anki", status: "failed", detail: "boom" },
  ]);
  assert.match(text, /markdown-log: written \/tmp\/a\.md/);
  assert.match(text, /anki: failed — boom/);
});
