import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { createDefaultConfig } = await import("../lib/config.ts");
const {
  localDateKey,
  localTimeLabel,
  markdownLogSink,
  renderReviewLogHeader,
  renderReviewLogSection,
  yamlScalar,
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

test("concurrent first writes to an absent daily log preserve both reviews and one header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-concurrent-log-"));
  const config = tempConfig(dir);
  const firstReview = review({ prompt: "first concurrent review" });
  const secondReview = review({ prompt: "second concurrent review" });
  const path = reviewLogPath(config, firstReview);
  assert.equal(existsSync(path), false, "the daily log must be absent before both writes begin");

  const results = await Promise.all([
    markdownLogSink.write(firstReview, config),
    markdownLogSink.write(secondReview, config),
  ]);

  assert.deepEqual(results.map((result) => result.status), ["written", "written"]);
  const content = readFileSync(path, "utf8");
  assert.equal(content.match(/target_language:/g).length, 1, "frontmatter must be written once");
  assert.equal(content.match(/^## /gm).length, 2);
  assert.match(content, /first concurrent review/);
  assert.match(content, /second concurrent review/);
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

test("an enable check failure is reported without stopping later matching sinks", async () => {
  const calls = [];
  const sinks = [
    {
      id: "broken",
      trigger: "auto",
      isEnabled() {
        calls.push("broken:enabled");
        throw new Error("enable check failed");
      },
      write: () => assert.fail("a sink with a failed enable check must not write"),
    },
    {
      id: "disabled",
      trigger: "auto",
      isEnabled() {
        calls.push("disabled:enabled");
        return false;
      },
      write: () => assert.fail("a disabled sink must not write"),
    },
    {
      id: "manual",
      trigger: "manual",
      isEnabled: () => assert.fail("a nonmatching sink must not evaluate enablement"),
      write: () => assert.fail("a nonmatching sink must not write"),
    },
    {
      id: "working",
      trigger: "auto",
      isEnabled() {
        calls.push("working:enabled");
        return true;
      },
      async write() {
        calls.push("working:write");
        return { sinkId: "working", status: "written" };
      },
    },
  ];

  const results = await runSinks(review(), createDefaultConfig(), "auto", sinks);
  assert.deepEqual(calls, ["broken:enabled", "disabled:enabled", "working:enabled", "working:write"]);
  assert.deepEqual(results, [
    { sinkId: "broken", status: "failed", detail: "enable check failed" },
    { sinkId: "working", status: "written" },
  ]);
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

function directAnkiConfig() {
  const config = tempConfig(mkdtempSync(join(tmpdir(), "pi-lingua-anki-direct-")));
  config.sinks.anki.enabled = true;
  config.sinks.anki.mode = "ankiconnect";
  config.sinks.anki.deck = "Deck::X";
  return config;
}

for (const { name, reason, respond } of [
  {
    name: "an AnkiConnect error",
    reason: "cannot create note because it is a duplicate",
    respond: (reason) => Response.json({ result: null, error: reason }),
  },
  {
    name: "a thrown request error",
    reason: "connection lost",
    respond: (reason) => { throw new Error(reason); },
  },
]) {
  test(`the anki sink reports confirmed progress and stops after ${name}`, async (t) => {
    const config = directAnkiConfig();
    const requests = [];
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      const { action, params } = JSON.parse(options.body);
      requests.push([action, params?.note.fields.Front]);
      if (action === "version") return Response.json({ result: 6, error: null });
      if (params.note.fields.Front === "fix") return Response.json({ result: 123, error: null });
      return respond(reason);
    });

    const result = await ankiSink.write(review({ vocabulary: [
      { from: "fix", to: "resolve" },
      { from: "test", to: "verify" },
      { from: "finish", to: "complete" },
    ] }), config);
    assert.deepEqual(result, {
      sinkId: "anki",
      status: "failed",
      detail: `AnkiConnect: confirmed 1 of 3 requested card(s); no confirmation for card 2 ("test"): ${reason}`,
    });
    assert.deepEqual(requests, [["version", undefined], ["addNote", "fix"], ["addNote", "test"]]);
    assert.equal(existsSync(config.sinks.anki.tsvPath), false);
  });
}

test("the anki sink still reports all notes on full direct success", async (t) => {
  const config = directAnkiConfig();
  t.mock.method(globalThis, "fetch", async (_url, options) => Response.json({
    result: JSON.parse(options.body).action === "version" ? 6 : 123,
    error: null,
  }));

  const result = await ankiSink.write(review({ vocabulary: [
    { from: "fix", to: "resolve" },
    { from: "test", to: "verify" },
  ] }), config);
  assert.deepEqual(result, {
    sinkId: "anki",
    status: "written",
    detail: "added 2 note(s) to Deck::X: fix, test",
  });
  assert.equal(existsSync(config.sinks.anki.tsvPath), false);
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

test("language labels that could alter YAML are quoted and round-trip in one frontmatter block", () => {
  const labels = [
    "English: formal",
    "Pig # Latin",
    'say "hi"',
    "back\\slash",
    "line1\nline2\r\nline3",
    "ends with space ",
    "- dash",
    "null",
    "sep arator",
    "",
  ];
  for (const label of labels) {
    const header = renderReviewLogHeader(
      review({ targetLanguageName: label, nativeLanguageName: label }),
    );
    const match = header.match(/^---\n([\s\S]*?)\n---\n\n$/);
    assert.ok(match, `one closed frontmatter block for ${JSON.stringify(label)}`);
    const lines = match[1].split("\n");
    assert.equal(lines.length, 3, `no extra physical lines for ${JSON.stringify(label)}`);
    assert.match(lines[0], /^date: /);
    for (const [index, key] of [
      [1, "target_language"],
      [2, "native_language"],
    ]) {
      assert.ok(lines[index].startsWith(`${key}: `), `${key} key for ${JSON.stringify(label)}`);
      const raw = lines[index].slice(key.length + 2);
      assert.equal(JSON.parse(raw), label, `${key} round-trips`);
    }
    assert.equal(header.split("---").length, 3, "exactly one frontmatter block");
  }
});

test("ordinary language labels stay plain and readable in the frontmatter", () => {
  const header = renderReviewLogHeader(review());
  assert.match(header, /\ntarget_language: English\nnative_language: Japanese\n/);
  assert.equal(yamlScalar("日本語"), "日本語");
  assert.equal(yamlScalar("Chinese (Traditional)"), "Chinese (Traditional)");
});

test("the markdown-log sink writes a safely quoted header for unusual labels", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-lingua-quoted-"));
  const config = tempConfig(dir);
  const odd = review({ targetLanguageName: 'English: US # "x"\nextra: 1' });
  const result = await markdownLogSink.write(odd, config);
  assert.equal(result.status, "written");
  const content = readFileSync(result.path, "utf8");
  assert.match(
    content,
    /^---\ndate: [^\n]*\ntarget_language: "English: US # \\"x\\"\\nextra: 1"\nnative_language: Japanese\n---\n\n## /,
  );
  const frontmatter = content.slice(0, content.indexOf("\n---\n\n"));
  assert.equal(frontmatter.match(/^extra:/gm), null);
});
