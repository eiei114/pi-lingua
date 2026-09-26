import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const { default: extension, REVIEW_ENTRY_TYPE, REVIEW_WIDGET_KEY } = await import(
  "../extensions/index.ts"
);

const REVIEWER_JSON = JSON.stringify({
  rendering: "Fix the login bug",
  changes: [{ from: "the bug of login", to: "the login bug" }],
  note: "noun の修飾は前置が自然",
  vocabulary: [{ from: "fix", to: "resolve", gloss: "強度" }],
});

function createPi() {
  const handlers = new Map();
  const commands = [];
  const entryRenderers = [];
  const entries = [];

  return {
    on(name, handler) {
      handlers.set(name, handler);
    },
    registerCommand(name, options) {
      commands.push({ name, description: options.description, handler: options.handler });
    },
    registerEntryRenderer(type, renderer) {
      entryRenderers.push({ type, renderer });
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    state: { handlers, commands, entryRenderers, entries },
  };
}

function createCtx(cwd, { complete } = {}) {
  const widgets = new Map();
  const notifications = [];
  const model = {
    id: "fake-model",
    provider: "fake",
    api: "anthropic-messages",
    name: "Fake",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    cost: {},
    contextWindow: 100000,
    maxTokens: 4096,
  };

  return {
    cwd,
    hasUI: true,
    model,
    modelRegistry: {
      find: (provider, id) => (provider === "fake" && id === "fake-model" ? model : undefined),
      getAvailable: () => [model],
      hasConfiguredAuth: () => true,
      complete:
        complete ??
        (async () => ({ content: [{ type: "text", text: REVIEWER_JSON }], stopReason: "stop" })),
      streamSimple: () => ({
        result:
          complete ??
          (async () => ({ content: [{ type: "text", text: REVIEWER_JSON }], stopReason: "stop" })),
      }),
    },
    ui: {
      setWidget(key, content) {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      },
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
    state: { widgets, notifications },
  };
}

function createTheme(backgrounds = []) {
  return {
    bg(color, text) {
      backgrounds.push(color);
      return text;
    },
    fg(_color, text) {
      return text;
    },
    bold(text) {
      return text;
    },
  };
}

function backgroundBands(backgrounds) {
  return backgrounds.filter((color, index) => color !== backgrounds[index - 1]);
}

function projectWithConfig() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-lingua-ext-"));
  const logDir = join(cwd, "reviews");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ "pi-lingua": { sinks: { reviewLog: { dir: logDir } } } }),
    "utf8",
  );
  return { cwd, logDir };
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

function readOnlyLog(logDir) {
  const files = (existsSync(logDir) ? readdirSync(logDir) : []).filter((name) => name.endsWith(".md"));
  assert.equal(files.length, 1, `expected one log file, found ${files.join(", ")}`);
  return readFileSync(join(logDir, files[0]), "utf8");
}

function logFileCount(logDir) {
  return existsSync(logDir) ? readdirSync(logDir).length : 0;
}

/**
 * The widget is set before the sinks run, on purpose: feedback should appear without waiting on disk
 * I/O. Tests that assert on the log therefore have to wait for the sink separately.
 */
async function waitForLog(logDir) {
  const ok = await waitFor(() => {
    try {
      return readOnlyLogContent(logDir).length > 0;
    } catch {
      return false;
    }
  });
  assert.ok(ok, `expected a review log with content under ${logDir}`);
}

function readOnlyLogContent(logDir) {
  const files = (existsSync(logDir) ? readdirSync(logDir) : []).filter((name) => name.endsWith(".md"));
  return files.map((name) => readFileSync(join(logDir, name), "utf8")).join("");
}

test("the extension registers the input hook, the entry renderer, and eight namespaced commands", () => {
  const pi = createPi();
  extension(pi);

  assert.ok(pi.state.handlers.has("input"), "input hook must be registered");
  assert.deepEqual(
    pi.state.entryRenderers.map((entry) => entry.type),
    [REVIEW_ENTRY_TYPE],
  );
  assert.deepEqual(
    pi.state.commands.map((command) => command.name),
    [
      "lingua:last",
      "lingua:card",
      "lingua:off",
      "lingua:on",
      "lingua:status",
      "lingua:configure",
      "lingua:model",
      "lingua:effort",
    ],
  );
  for (const command of pi.state.commands) {
    assert.match(command.name, /^lingua:[a-z-]+$/, "commands use the flat colon form");
    assert.equal(typeof command.description, "string");
    assert.ok(command.description.length > 0, `${command.name} needs a description`);
  }
});

/**
 * ADR-0001 as an executable invariant. The prompt must reach the agent untouched, and the handler
 * must return while the reviewer call is still unresolved.
 */
test("submitting a prompt never waits for the review and never rewrites it", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd, logDir } = projectWithConfig();
  let releaseReview;
  const ctx = createCtx(cwd, {
    complete: () =>
      new Promise((resolve) => {
        releaseReview = () =>
          resolve({ content: [{ type: "text", text: REVIEWER_JSON }], stopReason: "stop" });
      }),
  });

  const handler = pi.state.handlers.get("input");
  const result = await handler(
    { type: "input", text: "fix the bug of login", source: "interactive" },
    ctx,
  );

  assert.deepEqual(result, { action: "continue" });
  assert.equal(
    ctx.state.widgets.size,
    0,
    "the widget must not exist yet — the handler returned before the review finished",
  );

  releaseReview();
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0), "the review should land afterwards");

  const backgrounds = [];
  const component = ctx.state.widgets.get(REVIEW_WIDGET_KEY)(undefined, createTheme(backgrounds));
  const widget = component.render(72);
  assert.equal(widget[0].trim(), "EN review");
  assert.ok(widget.some((line) => line.includes("the login bug")));
  assert.ok(widget.some((line) => line.includes("◆ vocab")));
  assert.deepEqual(backgroundBands(backgrounds), ["selectedBg", "customMessageBg", "selectedBg"]);
  assert.equal(widget.filter((line) => line === "").length, 2, "unfilled gaps separate adjacent blocks");
  assert.ok(component.render(12).length > widget.length, "resizing reflows the full review");

  await waitForLog(logDir);
  const log = readOnlyLog(logDir);
  assert.match(log, /target_language: English/);
  assert.match(log, /fix the bug of login/);
  assert.match(log, /fix → resolve/);
});

test("short native reviews keep alternating bands and a gap at narrow widths", async () => {
  const pi = createPi();
  extension(pi);
  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd, {
    complete: async () => ({
      content: [{ type: "text", text: JSON.stringify({ rendering: "Fix the login bug", changes: [], vocabulary: [] }) }],
      stopReason: "stop",
    }),
  });

  await pi.state.handlers.get("input")(
    { type: "input", text: "ログインのバグを直して", source: "interactive" }, ctx,
  );
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0));
  const backgrounds = [];
  const component = ctx.state.widgets.get(REVIEW_WIDGET_KEY)(undefined, createTheme(backgrounds));
  const lines = component.render(12);
  assert.deepEqual(backgroundBands(backgrounds), ["selectedBg", "customMessageBg"]);
  assert.equal(lines.filter((line) => line === "").length, 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 12));
  assert.ok(lines.join("").replace(/\s/g, "").includes("Fix the login bug".replace(/\s/g, "")));
});

test("a command-looking prompt is left alone and produces no review", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");

  const result = await handler({ type: "input", text: "/lingua:off", source: "interactive" }, ctx);
  assert.deepEqual(result, { action: "continue" });

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(ctx.state.widgets.size, 0);
});

test("extension-injected messages are not reviewed", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd, logDir } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");

  await handler(
    { type: "input", text: "an injected message that should not be reviewed", source: "extension" },
    ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(ctx.state.widgets.size, 0);
  assert.equal(logFileCount(logDir), 0);
});

test("lingua:off stops review and clears the widget, lingua:on resumes", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd, logDir } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");
  const run = (name, args = "") =>
    pi.state.commands.find((command) => command.name === name).handler(args, ctx);

  await handler({ type: "input", text: "fix the bug of login", source: "interactive" }, ctx);
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0));
  await waitForLog(logDir);
  const reviewedFiles = logFileCount(logDir);

  await run("lingua:off");
  assert.equal(ctx.state.widgets.size, 0);

  await handler(
    { type: "input", text: "please review this sentence as well", source: "interactive" },
    ctx,
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(logFileCount(logDir), reviewedFiles, "no review should run while off");

  await run("lingua:on");
  await handler(
    { type: "input", text: "please review this sentence as well", source: "interactive" },
    ctx,
  );
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0), "review should resume");
});

test("lingua:last appends an entry that does not enter the LLM context", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");

  await handler({ type: "input", text: "fix the bug of login", source: "interactive" }, ctx);
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0));

  const last = pi.state.commands.find((command) => command.name === "lingua:last");
  await last.handler("", ctx);

  assert.equal(pi.state.entries.length, 1);
  assert.equal(pi.state.entries[0].type, REVIEW_ENTRY_TYPE);
  assert.equal(pi.state.entries[0].data.rendering, "Fix the login bug");

  const backgrounds = [];
  const renderer = pi.state.entryRenderers[0].renderer;
  const component = renderer({ data: pi.state.entries[0].data }, { expanded: false }, createTheme(backgrounds));
  const detail = component.render(80);
  assert.deepEqual(backgroundBands(backgrounds), [
    "selectedBg", "customMessageBg", "selectedBg", "customMessageBg", "selectedBg",
  ]);
  assert.equal(detail.filter((line) => line === "").length, 4);
});

test("lingua:last explains itself when nothing has been reviewed yet", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const last = pi.state.commands.find((command) => command.name === "lingua:last");
  await last.handler("", ctx);

  assert.equal(pi.state.entries.length, 0);
  assert.match(ctx.state.notifications.at(-1).message, /No Prompt Review/);
});

test("lingua:card reports that the Anki sink is disabled instead of failing silently", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");
  await handler({ type: "input", text: "fix the bug of login", source: "interactive" }, ctx);
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0));

  const card = pi.state.commands.find((command) => command.name === "lingua:card");
  await card.handler("", ctx);

  const notification = ctx.state.notifications.at(-1);
  assert.equal(notification.type, "warning");
  assert.match(notification.message, /Anki sink is disabled/);
});

test("lingua:status reports the reviewer model and sink state", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const handler = pi.state.handlers.get("input");
  await handler({ type: "input", text: "fix the bug of login", source: "interactive" }, ctx);
  assert.ok(await waitFor(() => ctx.state.widgets.size > 0));

  const status = pi.state.commands.find((command) => command.name === "lingua:status");
  await status.handler("", ctx);

  const message = ctx.state.notifications.at(-1).message;
  assert.match(message, /pi-lingua: on/);
  assert.match(message, /reviewer: fake\/fake-model/);
  assert.match(message, /reviewed 1/);
  assert.match(message, /sink markdown-log: enabled/);
});

test("lingua:configure prints a pasteable settings block", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd);
  const configure = pi.state.commands.find((command) => command.name === "lingua:configure");
  await configure.handler("", ctx);

  const message = ctx.state.notifications.at(-1).message;
  assert.match(message, /"pi-lingua"/);
  assert.match(message, /"targetLanguage": "en"/);
});

test("a reviewer that returns unusable output warns instead of showing an empty widget", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd, {
    complete: async () => ({ content: [{ type: "text", text: "I cannot review this." }], stopReason: "stop" }),
  });

  const handler = pi.state.handlers.get("input");
  await handler({ type: "input", text: "fix the bug of login", source: "interactive" }, ctx);

  assert.ok(await waitFor(() => ctx.state.notifications.length > 0));
  assert.equal(ctx.state.widgets.size, 0);
  assert.match(ctx.state.notifications.at(-1).message, /did not return usable JSON/);
});

test("a failing reviewer call is reported and does not reject the input handler", async () => {
  const pi = createPi();
  extension(pi);

  const { cwd } = projectWithConfig();
  const ctx = createCtx(cwd, {
    complete: async () => {
      throw new Error("provider exploded");
    },
  });

  const handler = pi.state.handlers.get("input");
  const result = await handler(
    { type: "input", text: "fix the bug of login", source: "interactive" },
    ctx,
  );
  assert.deepEqual(result, { action: "continue" });

  assert.ok(await waitFor(() => ctx.state.notifications.length > 0));
  assert.match(ctx.state.notifications.at(-1).message, /provider exploded/);
});
