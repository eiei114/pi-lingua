import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  behaviorAssertions,
  casePassed,
  EXTENSION_LOAD_ERROR_PATTERN,
  HOST_RESPONSE,
  MALFORMED_REVIEWER_RESPONSE,
  parseJsonLines,
  REVIEW_RENDERING,
  SDK_VERSIONS,
  UNHANDLED_ERROR_PATTERN,
  VERIFICATION_CONTRACT,
} from "./pi-sdk-smoke-contract.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORT_PATH = join(ROOT, "docs", "verification", "pi-sdk-smoke.json");
const EXTENSION_PATH = join(ROOT, "extensions", "index.ts");
const PROVIDER_ID = "pi-lingua-smoke-provider";
const MODEL_ID = "pi-lingua-smoke";
const INPUT_TEXT = "please fix the bug of login now";
const RPC_DEADLINE_MS = 15_000;
const CLEANUP_GRACE_MS = 1_000;
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

const manifest = readJson(join(ROOT, "package.json"));
for (const [name, version] of Object.entries(SDK_VERSIONS)) {
  assert.equal(manifest.devDependencies?.[name], version, `exact dev/test pin required for ${name}`);
  assert.equal(readJson(join(ROOT, "node_modules", name, "package.json")).version, version,
    `installed SDK version mismatch for ${name}`);
}

const codingAgentDir = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const piManifest = readJson(join(codingAgentDir, "package.json"));
const piCli = resolve(codingAgentDir, piManifest.bin.pi);
const sdkVersion = SDK_VERSIONS["@earendil-works/pi-coding-agent"];

function textOf(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

function parseBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        rejectBody(error);
      }
    });
    req.on("error", rejectBody);
  });
}

let activeCase = "startup";
const providerCalls = [];
const reviewReply = JSON.stringify({
  rendering: REVIEW_RENDERING,
  speaking: {
    chunked: "Please fix / the login bug now.",
    ipa: "pliːz fɪks / ðə ˈlɔːɡɪn bʌɡ naʊ",
    kana: "プリーズ フィックス / ザ ログイン バグ ナウ",
  },
  changes: [{ from: "the bug of login", to: "the login bug" }],
  note: "noun の修飾は名詞の前に置く",
  vocabulary: [{ from: "fix", to: "resolve", gloss: "より明確な動詞" }],
});

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }

  let payload;
  try {
    payload = await parseBody(req);
  } catch (error) {
    res.writeHead(400).end(JSON.stringify({ error: String(error) }));
    return;
  }

  const systemText = (payload.messages ?? []).filter((message) => message.role === "system")
    .map((message) => textOf(message.content)).join("\n");
  const reviewer = systemText.includes("You review the wording of a single message a developer is about to send to a coding agent.");
  const content = reviewer
    ? activeCase === "error_path" ? MALFORMED_REVIEWER_RESPONSE : reviewReply
    : HOST_RESPONSE;
  providerCalls.push({
    case: activeCase,
    kind: reviewer ? "pi-lingua-reviewer" : "Pi host model",
    model: payload.model ?? null,
    stream: payload.stream === true,
    systemPromptIdentified: reviewer,
    userText: (payload.messages ?? []).filter((message) => message.role === "user")
      .map((message) => textOf(message.content)).join("\n").slice(0, 500),
    response: content,
  });

  const created = Math.floor(Date.now() / 1000);
  const id = `pi-lingua-smoke-${providerCalls.length}`;
  if (payload.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const chunks = [
      { role: "assistant" },
      { content },
      {},
    ];
    for (let index = 0; index < chunks.length; index += 1) {
      const final = index === chunks.length - 1;
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model: payload.model ?? MODEL_ID,
        choices: [{ index: 0, delta: chunks[index], finish_reason: final ? "stop" : null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    res.end("data: [DONE]\n\n");
    return;
  }

  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model: payload.model ?? MODEL_ID,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  }));
});

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

class PiRpcProcess {
  constructor(agentDir, projectDir) {
    this.deadlineAt = Date.now() + RPC_DEADLINE_MS;
    this.records = [];
    this.waiters = new Set();
    this.stdout = "";
    this.stderr = "";
    this.partialLine = "";
    this.forced = false;
    this.startupError = undefined;

    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    };
    const args = [
      piCli,
      "--offline",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--provider", PROVIDER_ID,
      "--model", MODEL_ID,
      "--extension", EXTENSION_PATH,
      "--mode", "rpc",
    ];
    this.child = spawn(process.execPath, args, { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.closePromise = new Promise((resolveClose) => {
      this.child.once("error", (error) => { this.startupError = error.message; });
      this.child.once("close", (code, signal) => resolveClose({ exit_code: code, signal, forced: this.forced }));
    });
    this.child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      this.stdout += text;
      this.partialLine += text;
      let newline;
      while ((newline = this.partialLine.indexOf("\n")) !== -1) {
        const line = this.partialLine.slice(0, newline).replace(/\r$/, "");
        this.partialLine = this.partialLine.slice(newline + 1);
        this.consumeLine(line);
      }
    });
    this.child.stdout.on("end", () => {
      if (this.partialLine.trim()) this.consumeLine(this.partialLine.replace(/\r$/, ""));
      this.partialLine = "";
    });
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk.toString("utf8"); });
  }

  consumeLine(line) {
    if (!line.trim()) return;
    try {
      const record = JSON.parse(line);
      this.records.push(record);
      for (const waiter of [...this.waiters]) {
        if (waiter.predicate(record)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(record);
        }
      }
    } catch {
      // Keep non-protocol output in stdout evidence; never reinterpret it as an RPC record.
    }
  }

  remainingMs() {
    return Math.max(0, this.deadlineAt - Date.now());
  }

  async waitForRecord(predicate, label) {
    const existing = this.records.find(predicate);
    if (existing) return existing;
    const remaining = this.remainingMs();
    if (remaining <= 0) throw new Error(`${label} exceeded the ${RPC_DEADLINE_MS}ms Pi-process deadline`);

    const recordPromise = new Promise((resolveRecord, rejectRecord) => {
      const waiter = { predicate, resolve: resolveRecord, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        rejectRecord(new Error(`${label} exceeded the ${RPC_DEADLINE_MS}ms Pi-process deadline`));
      }, remaining);
      this.waiters.add(waiter);
    });
    const closedPromise = this.closePromise.then((close) => {
      throw new Error(`${label}: Pi exited early (code ${close.exit_code}, signal ${close.signal ?? "none"})`);
    });
    return Promise.race([recordPromise, closedPromise]);
  }

  async send(command) {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error("Pi RPC stdin is closed");
    const data = `${JSON.stringify(command)}\n`;
    if (this.child.stdin.write(data)) return;
    await withTimeout(new Promise((resolveDrain, rejectDrain) => {
      this.child.stdin.once("drain", resolveDrain);
      this.child.stdin.once("error", rejectDrain);
    }), this.remainingMs(), "Pi RPC stdin backpressure");
  }

  async command(command, id) {
    await this.send({ id, ...command });
    return this.waitForRecord((record) => record?.type === "response" && record.id === id, `${command.type} RPC response`);
  }

  async getCommands(id) {
    const result = await this.command({ type: "get_commands" }, id);
    if (!result.success) throw new Error(`get_commands failed: ${result.error ?? "unknown error"}`);
    return result.data?.commands ?? [];
  }

  async getMessages(id) {
    const result = await this.command({ type: "get_messages" }, id);
    if (!result.success) throw new Error(`get_messages failed: ${result.error ?? "unknown error"}`);
    return result.data?.messages ?? [];
  }

  async prompt(message, id) {
    const response = await this.command({ type: "prompt", message }, id);
    if (!response.success) throw new Error(`prompt rejected: ${response.error ?? "unknown error"}`);
    if (response.data?.disposition === "started") {
      await this.waitForRecord((record) => record?.type === "agent_settled", "agent_settled event");
    }
    return response;
  }

  async queryStatus(label, predicate) {
    const until = Math.min(this.deadlineAt - 500, Date.now() + 6_000);
    let attempt = 0;
    while (Date.now() < until) {
      attempt += 1;
      const requestId = `${label}-status-${attempt}`;
      const startIndex = this.records.length;
      const response = await this.command({ type: "prompt", message: "/lingua:status" }, requestId);
      if (!response.success || response.data?.disposition !== "handled") {
        throw new Error(`lingua:status was not handled: ${JSON.stringify(response)}`);
      }
      const remaining = Math.max(1, Math.min(until - Date.now(), this.remainingMs()));
      let status;
      try {
        status = await withTimeout(this.waitForRecord((record) => {
          const index = this.records.indexOf(record);
          return index >= startIndex && record?.type === "extension_ui_request"
            && record.method === "notify" && typeof record.message === "string"
            && record.message.startsWith("pi-lingua: on");
        }, "pi-lingua status notification"), remaining, "pi-lingua status notification");
      } catch (error) {
        if (Date.now() >= until) throw error;
      }
      if (status && predicate(status.message)) return status.message;
      await delay(Math.min(100, Math.max(0, until - Date.now())));
    }
    throw new Error(`${label} did not reach the expected pi-lingua status before its deadline`);
  }

  async close() {
    if (!this.child.stdin.destroyed && !this.child.stdin.writableEnded) this.child.stdin.end();
    try {
      const remaining = this.remainingMs();
      if (remaining <= 0) throw new Error("Pi process deadline expired before natural shutdown");
      return await withTimeout(this.closePromise, remaining, "natural Pi shutdown");
    } catch {
      this.forced = true;
      this.child.kill();
      if (process.platform === "win32" && this.child.pid) {
        const taskkill = spawn("taskkill.exe", ["/PID", String(this.child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        await withTimeout(new Promise((resolveKill) => taskkill.once("close", resolveKill)), CLEANUP_GRACE_MS, "taskkill cleanup")
          .catch(() => undefined);
      }
      try {
        return { ...(await withTimeout(this.closePromise, CLEANUP_GRACE_MS, "Pi cleanup grace")), forced: true };
      } catch {
        return { exit_code: null, signal: null, forced: true };
      }
    }
  }

  output() {
    return `${this.stdout}${this.stderr}`;
  }
}

async function runNativeCommand(file, args, env = process.env, cwd = ROOT) {
  const startedAt = Date.now();
  const child = spawn(file, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  let startupError;
  let forced = false;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  child.once("error", (error) => { startupError = error.message; });
  const closePromise = new Promise((resolveClose) => {
    child.once("close", (code, signal) => resolveClose({ exit_code: code, signal, forced }));
  });
  let result;
  try {
    result = await withTimeout(closePromise, RPC_DEADLINE_MS, "native shell Pi version probe");
  } catch {
    forced = true;
    child.kill();
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await withTimeout(new Promise((resolveKill) => killer.once("close", resolveKill)), CLEANUP_GRACE_MS, "shell taskkill cleanup")
        .catch(() => undefined);
    }
    result = await withTimeout(closePromise, CLEANUP_GRACE_MS, "native shell cleanup grace")
      .catch(() => ({ exit_code: null, signal: null, forced: true }));
  }
  return { ...result, forced, stdout, stderr, startupError, duration_ms: Date.now() - startedAt };
}

function createAgentDir(port) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-lingua-sdk-smoke-"));
  const projectDir = join(agentDir, "project");
  const reviewDir = join(agentDir, "reviews");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(reviewDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({
    providers: {
      [PROVIDER_ID]: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        api: "openai-completions",
        apiKey: "offline-test-only",
        models: [{
          id: MODEL_ID,
          name: "Pi Lingua Offline Smoke Model",
          reasoning: false,
          input: ["text"],
          contextWindow: 16_000,
          maxTokens: 1_024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify({
    "pi-lingua": {
      enabled: true,
      reviewer: { provider: PROVIDER_ID, model: MODEL_ID },
      sinks: { reviewLog: { enabled: true, dir: reviewDir } },
    },
  }, null, 2)}\n`, "utf8");
  return { agentDir, projectDir, reviewDir };
}

function commandNames(commands) {
  return commands.filter((command) => command.source === "extension").map((command) => command.name);
}

async function startWithCommands(environment, label) {
  const rpc = new PiRpcProcess(environment.agentDir, environment.projectDir);
  try {
    const commands = await rpc.getCommands(`${label}-commands`);
    return { rpc, commands, commandsSuccess: true, error: undefined };
  } catch (error) {
    const close = await rpc.close();
    return { rpc, commands: [], commandsSuccess: false, error: error.message, earlyClose: close };
  }
}

async function runInteraction(rpc, label, inputText, expectedStatus) {
  const prompt = await rpc.prompt(inputText, `${label}-input`);
  const messages = await rpc.getMessages(`${label}-messages`);
  const userText = messages.findLast((message) => message.role === "user")?.content;
  const assistantText = messages.findLast((message) => message.role === "assistant")?.content;
  const statusMessage = await rpc.queryStatus(label, expectedStatus);
  return {
    prompt,
    userText: textOf(userText),
    assistantText: textOf(assistantText),
    statusMessage,
  };
}

function readReviewLog(reviewDir) {
  if (!existsSync(reviewDir)) return { contents: "", files: [] };
  const files = readdirSync(reviewDir).filter((name) => name.endsWith(".md"));
  return {
    files,
    contents: files.map((name) => readFileSync(join(reviewDir, name), "utf8")).join("\n"),
  };
}

function countOccurrences(value, needle) {
  return value.split(needle).length - 1;
}

async function waitForReviewCount(reviewDir, minimum, rpc) {
  const deadline = Math.min(Date.now() + 3_000, rpc.deadlineAt - 500);
  while (Date.now() < deadline) {
    const log = readReviewLog(reviewDir);
    if (countOccurrences(log.contents, REVIEW_RENDERING) >= minimum) return log;
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`markdown sink did not persist ${minimum} review(s) before the Pi RPC deadline`);
}

function displayPath(path) {
  const homeRelative = relative(homedir(), path);
  if (isAbsolute(homeRelative) || homeRelative === ".." || homeRelative.startsWith("../")
    || homeRelative.startsWith("..\\")) return [];
  const posix = `~/${homeRelative.replaceAll("\\", "/")}`;
  return [posix, posix.replaceAll("/", "\\")];
}

function evidencePathForms(path) {
  const forms = new Set([path, path.replaceAll("\\", "/"), ...displayPath(path)]);
  let escaped = [...forms];
  for (let depth = 0; depth < 3; depth += 1) {
    escaped = escaped.map((item) => item.replaceAll("\\", "\\\\"));
    for (const item of escaped) forms.add(item);
  }
  return [...forms];
}

function sanitize(value, agentDir) {
  const isolatedPaths = evidencePathForms(agentDir);
  const repoPaths = evidencePathForms(ROOT);
  let result = String(value);
  for (const path of isolatedPaths) result = result.replaceAll(path, "<isolated-agent-dir>");
  for (const path of repoPaths) result = result.replaceAll(path, "<repo>");
  return result;
}

function capturedRecords(stdout) {
  return parseJsonLines(stdout).flatMap((record) => {
    if (record?.type === "response" && record.command === "get_messages") {
      return [{ ...record, data: { ...record.data, messages: (record.data?.messages ?? [])
        .filter((message) => message.role === "user" || message.role === "assistant") } }];
    }
    if (record?.type === "response" && ["get_commands", "prompt"].includes(record.command)) return [record];
    if (record?.type === "message_end" && ["user", "assistant"].includes(record.message?.role)) return [record];
    if (record?.type === "agent_settled" || record?.type === "extension_error") return [record];
    if (record?.type === "extension_ui_request" && record.method === "notify") return [record];
    return [];
  });
}

function sanitizeValue(value, agentDir) {
  if (typeof value === "string") return sanitize(value, agentDir);
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, agentDir));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, agentDir)]));
  }
  return value;
}

function processEvidence(processes, agentDir, calls, details = {}) {
  return JSON.stringify({
    processes: processes.map((processResult) => ({
      stdout_records: capturedRecords(processResult.stdout ?? "").map((record) => sanitizeValue(record, agentDir)),
      stderr: sanitize(processResult.stderr ?? "", agentDir),
      exit_code: processResult.exit_code,
      signal: processResult.signal,
      forced: processResult.forced,
      error: processResult.error ? sanitize(processResult.error, agentDir) : null,
    })),
    provider_calls: calls,
    ...details,
  });
}

async function runExtensionLoadCase(environment) {
  activeCase = "extension_load";
  const start = await startWithCommands(environment, "load");
  const close = await start.rpc.close();
  const processResult = {
    ...close,
    stdout: start.rpc.stdout,
    stderr: start.rpc.stderr,
    error: start.error,
    output: start.rpc.output(),
  };
  const calls = providerCalls.filter((call) => call.case === activeCase);
  const assertions = behaviorAssertions("extension_load", {
    commands: commandNames(start.commands),
    commandsSuccess: start.commandsSuccess,
  });
  return {
    name: "extension_load",
    command: "npm run smoke:pi",
    exit_code: close.exit_code === 0 && !start.error ? 0 : 1,
    passed: casePassed(assertions, [processResult]),
    evidence: processEvidence([processResult], environment.agentDir, calls),
    assertions,
    processResults: [processResult],
  };
}

async function runPromptCase(name, environment, inputText, mode) {
  activeCase = name;
  const start = await startWithCommands(environment, name);
  let interaction;
  let statusMessage;
  let reviewLog;
  let failureNotification;
  let reviewLogFiles = 0;
  let commands = commandNames(start.commands);
  let commandsSuccess = start.commandsSuccess;
  let caseError = start.error;
  try {
    if (start.error) throw new Error(start.error);
    const expectedStatus = mode === "error"
      ? (message) => message.includes("reviewed 0, skipped 1 (last skip: unparseable reviewer response)")
      : (message) => message.includes("reviewed 1, skipped 0");
    interaction = await runInteraction(start.rpc, name, inputText, expectedStatus);
    statusMessage = interaction.statusMessage;
    if (mode === "error") {
      failureNotification = start.rpc.records.find((record) => record?.type === "extension_ui_request"
        && record.method === "notify" && typeof record.message === "string"
        && record.message.includes("reviewer model did not return usable JSON"))?.message;
      reviewLogFiles = readReviewLog(environment.reviewDir).files.length;
    } else {
      const log = await waitForReviewCount(environment.reviewDir, 1, start.rpc);
      reviewLog = log.contents;
    }
  } catch (error) {
    caseError = error.message;
  }
  const close = await start.rpc.close();
  const processResult = {
    ...close,
    stdout: start.rpc.stdout,
    stderr: start.rpc.stderr,
    output: start.rpc.output(),
    error: caseError,
  };
  const records = start.rpc.records;
  const interactionDetails = interaction ?? {
    prompt: records.find((record) => record?.type === "response" && record.command === "prompt" && record.id === `${name}-input`),
    userText: undefined,
    assistantText: undefined,
  };
  const safeInteraction = interactionDetails.statusMessage
    ? { ...interactionDetails, statusMessage: sanitize(interactionDetails.statusMessage, environment.agentDir) }
    : interactionDetails;
  const observation = name === "error_path"
    ? {
      commands,
      commandsSuccess,
      interaction: safeInteraction,
      inputText,
      statusMessage: sanitize(statusMessage ?? "", environment.agentDir),
      failureNotification,
      reviewerResponse: providerCalls.find((call) => call.case === name && call.kind === "pi-lingua-reviewer")?.response,
      extensionErrors: records.filter((record) => record?.type === "extension_error").length,
      reviewLogFiles,
    }
    : { commands, commandsSuccess, interaction: safeInteraction, inputText, reviewLog };
  const calls = providerCalls.filter((call) => call.case === name);
  const assertions = behaviorAssertions(name, observation);
  return {
    name,
    command: "npm run smoke:pi",
    exit_code: close.exit_code === 0 && !caseError ? 0 : 1,
    passed: casePassed(assertions, [processResult]),
    evidence: processEvidence([processResult], environment.agentDir, calls, name === "error_path"
      ? { status_message: sanitize(statusMessage ?? "", environment.agentDir), failure_notification: failureNotification,
        review_log_files: reviewLogFiles }
      : { review_log: sanitize(reviewLog ?? "", environment.agentDir) }),
    assertions,
    processResults: [processResult],
  };
}

async function runReloadCase(environment) {
  activeCase = "reload_cleanup";
  const processes = [];
  let caseError;
  let second;
  let startFirst;
  let startSecond;
  let firstClosed = false;
  let secondClosed = false;
  try {
    startFirst = await startWithCommands(environment, "reload-first");
    if (startFirst.error) throw new Error(startFirst.error);
    await runInteraction(startFirst.rpc, "reload-first", "please review login wording before reload", (message) =>
      message.includes("reviewed 1, skipped 0"));
    await waitForReviewCount(environment.reviewDir, 1, startFirst.rpc);
    const firstClose = await startFirst.rpc.close();
    firstClosed = true;
    processes.push({ ...firstClose, stdout: startFirst.rpc.stdout, stderr: startFirst.rpc.stderr,
      output: startFirst.rpc.output(), error: undefined });

    startSecond = await startWithCommands(environment, "reload-second");
    second = { commands: commandNames(startSecond.commands), commandsSuccess: startSecond.commandsSuccess };
    if (startSecond.error) throw new Error(startSecond.error);
    second.interaction = await runInteraction(startSecond.rpc, "reload-second", INPUT_TEXT, (message) =>
      message.includes("reviewed 1, skipped 0"));
    await waitForReviewCount(environment.reviewDir, 2, startSecond.rpc);
    const secondClose = await startSecond.rpc.close();
    secondClosed = true;
    processes.push({ ...secondClose, stdout: startSecond.rpc.stdout, stderr: startSecond.rpc.stderr,
      output: startSecond.rpc.output(), error: undefined });
  } catch (error) {
    caseError = error.message;
  }
  if (startFirst && !firstClosed) {
    const close = await startFirst.rpc.close();
    processes.push({ ...close, stdout: startFirst.rpc.stdout, stderr: startFirst.rpc.stderr,
      output: startFirst.rpc.output(), error: caseError });
  }
  if (startSecond && !secondClosed) {
    const close = await startSecond.rpc.close();
    processes.push({ ...close, stdout: startSecond.rpc.stdout, stderr: startSecond.rpc.stderr,
      output: startSecond.rpc.output(), error: caseError });
  }

  const log = readReviewLog(environment.reviewDir);
  const reviewLogCount = countOccurrences(log.contents, REVIEW_RENDERING);
  const allOutput = processes.map((item) => item.output ?? "").join("\n");
  const safeSecond = second?.interaction?.statusMessage
    ? { ...second, interaction: { ...second.interaction,
      statusMessage: sanitize(second.interaction.statusMessage, environment.agentDir) } }
    : second;
  const observation = {
    second: safeSecond,
    inputText: INPUT_TEXT,
    reviewLogCount,
    processes,
    unhandledErrors: processes.filter((item) => UNHANDLED_ERROR_PATTERN.test(item.output ?? "")).length,
    extensionLoadErrors: processes.filter((item) => EXTENSION_LOAD_ERROR_PATTERN.test(item.output ?? "")).length,
  };
  const assertions = behaviorAssertions("reload_cleanup", observation);
  if (caseError) {
    assertions.push({ id: "reload_execution_completed", expected: "Both isolated Pi processes complete without harness errors",
      observed: JSON.stringify(caseError), passed: false });
  }
  const calls = providerCalls.filter((call) => call.case === activeCase);
  return {
    name: "reload_cleanup",
    command: "npm run smoke:pi",
    exit_code: !caseError && processes.length === 2 && processes.every((item) => item.exit_code === 0) ? 0 : 1,
    passed: casePassed(assertions, processes),
    evidence: processEvidence(processes, environment.agentDir, calls, {
      review_log: log.contents,
      harness_error: caseError ? sanitize(caseError, environment.agentDir) : null,
      combined_output_had_unhandled_errors: UNHANDLED_ERROR_PATTERN.test(allOutput),
    }),
    assertions,
    processResults: processes,
  };
}

function quotePowerShell(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function runHostShellCase(environment) {
  const isolatedEnv = {
    ...process.env,
    PI_CODING_AGENT_DIR: environment.agentDir,
    PI_CODING_AGENT_SESSION_DIR: join(environment.agentDir, "sessions"),
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  let file;
  let args;
  if (process.platform === "win32") {
    file = resolve(process.env.SystemRoot ?? "C:/Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const command = `& ${quotePowerShell(process.execPath)} ${quotePowerShell(piCli)} --no-extensions --version; exit $LASTEXITCODE`;
    args = ["-NoProfile", "-NonInteractive", "-Command", command];
  } else {
    file = "/bin/sh";
    args = ["-c", '"$1" "$2" --no-extensions --version', "pi-lingua-host-shell", process.execPath, piCli];
  }
  const result = await runNativeCommand(file, args, isolatedEnv, environment.projectDir);
  const observation = {
    exit_code: result.exit_code,
    output: result.stdout,
    expectedVersion: sdkVersion,
  };
  const assertions = behaviorAssertions("host_shell", observation);
  const processResult = {
    ...result,
    output: `${result.stdout}${result.stderr}${result.startupError ?? ""}`,
    error: result.startupError,
  };
  return {
    name: "host_shell",
    command: "npm run smoke:pi",
    exit_code: result.exit_code === 0 && !result.forced && !result.startupError ? 0 : 1,
    passed: casePassed(assertions, [processResult]),
    evidence: JSON.stringify({ command: [file, ...args].map((part) => sanitize(part, environment.agentDir)),
      stdout: result.stdout, stderr: sanitize(result.stderr, environment.agentDir),
      exit_code: result.exit_code, signal: result.signal, forced: result.forced,
      expected_version: sdkVersion,
      startup_error: result.startupError ? sanitize(result.startupError, environment.agentDir) : null }),
    assertions,
    processResults: [processResult],
  };
}

async function closeServer() {
  if (!server.listening) return;
  const deadline = Date.now() + CLEANUP_GRACE_MS;
  const closed = new Promise((resolveClose) => server.close(resolveClose));
  try {
    await withTimeout(closed, CLEANUP_GRACE_MS, "offline provider shutdown");
  } catch {
    server.closeAllConnections();
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      await withTimeout(closed, remaining, "offline provider cleanup grace").catch(() => undefined);
    }
  }
}

async function main() {
  const results = [];
  const environments = [];
  try {
    await new Promise((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address === "object", "offline provider must bind a local TCP port");
    const extensionLoadEnvironment = createAgentDir(address.port);
    environments.push(extensionLoadEnvironment);
    results.push(await runExtensionLoadCase(extensionLoadEnvironment));

    const happyEnvironment = createAgentDir(address.port);
    environments.push(happyEnvironment);
    results.push(await runPromptCase("happy_path", happyEnvironment, INPUT_TEXT, "success"));

    const errorEnvironment = createAgentDir(address.port);
    environments.push(errorEnvironment);
    results.push(await runPromptCase("error_path", errorEnvironment, INPUT_TEXT, "error"));

    const reloadEnvironment = createAgentDir(address.port);
    environments.push(reloadEnvironment);
    results.push(await runReloadCase(reloadEnvironment));

    const hostEnvironment = createAgentDir(address.port);
    environments.push(hostEnvironment);
    results.push(await runHostShellCase(hostEnvironment));
  } catch (error) {
    console.error(`Pi SDK smoke harness failed: ${error.stack ?? error}`);
  } finally {
    await closeServer();
    for (const environment of environments) {
      rmSync(environment.agentDir, { recursive: true, force: true });
    }
  }

  const allProcessResults = results.flatMap((item) => item.processResults ?? []);
  let report = {
    schema_version: 1,
    verification_contract: VERIFICATION_CONTRACT,
    sdk_versions: SDK_VERSIONS,
    platform: process.platform,
    model_inference: "No paid inference. A local deterministic OpenAI-compatible HTTP provider supplies host and reviewer responses; the actual pinned Pi CLI, SDK model runtime, pi-lingua extension, input hook, reviewer parser, settings, and markdown sink are exercised without mocked imports or lifecycle.",
    unhandled_errors: allProcessResults.filter((item) => UNHANDLED_ERROR_PATTERN.test(item.output ?? "")).length,
    extension_load_errors: allProcessResults.filter((item) => EXTENSION_LOAD_ERROR_PATTERN.test(item.output ?? "")).length,
    cases: results.map(({ processResults: _processResults, ...item }) => item),
  };
  for (const environment of environments) report = sanitizeValue(report, environment.agentDir);
  const reportText = JSON.stringify(report, null, 2);
  const privatePaths = [...evidencePathForms(ROOT),
    ...environments.flatMap(({ agentDir }) => evidencePathForms(agentDir))];
  if (privatePaths.some((path) => path.length > 2 && reportText.includes(path))) {
    throw new Error("Pi SDK smoke evidence contains an unsanitized local path");
  }
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${reportText}\n`, "utf8");
  console.log(JSON.stringify({ verification_contract: report.verification_contract, platform: report.platform,
    unhandled_errors: report.unhandled_errors, extension_load_errors: report.extension_load_errors,
    cases: report.cases.map(({ name, exit_code, passed, assertions }) => ({
      name, exit_code, passed, assertions: assertions.map(({ id, passed: assertionPassed }) => ({ id, passed: assertionPassed })),
    })) }, null, 2));
  if (report.cases.length !== 5 || report.cases.some((item) => !item.passed)
    || report.unhandled_errors !== 0 || report.extension_load_errors !== 0) process.exitCode = 1;
}

await main();
