import assert from "node:assert/strict";
import test from "node:test";
import {
  behaviorAssertions,
  HOST_RESPONSE,
  MALFORMED_REVIEWER_RESPONSE,
  parseJsonLines,
  REQUIRED_COMMANDS,
  REVIEW_RENDERING,
  SDK_VERSIONS,
  VERIFICATION_CONTRACT,
} from "../scripts/pi-sdk-smoke-contract.mjs";

const commands = REQUIRED_COMMANDS;
const interaction = (inputText) => ({
  prompt: { success: true, data: { disposition: "started" } },
  userText: inputText,
  assistantText: HOST_RESPONSE,
});
const successfulProcess = { exit_code: 0, signal: null, forced: false, output: "" };

test("smoke contract pins the four frozen SDK versions and parses JSONL", () => {
  assert.equal(VERIFICATION_CONTRACT, "pi-sdk-behavior-v2");
  assert.deepEqual(SDK_VERSIONS, {
    "@earendil-works/pi-agent-core": "1.2.0",
    "@earendil-works/pi-ai": "1.2.0",
    "@earendil-works/pi-coding-agent": "1.2.0",
    "@earendil-works/pi-tui": "1.2.0",
  });
  const record = { type: "response", command: "get_commands", success: true };
  assert.deepEqual(parseJsonLines(`not-json\r\n${JSON.stringify(record)}\n\n`), [record]);
});

test("extension registration requires the actual complete slash-command inventory", () => {
  assert.ok(behaviorAssertions("extension_load", { commands, commandsSuccess: true })[0].passed);
  assert.equal(behaviorAssertions("extension_load", { commands: commands.slice(1), commandsSuccess: true })[0].passed, false);
  assert.equal(behaviorAssertions("extension_load", { commands, commandsSuccess: false })[0].passed, false);
});

test("happy path requires unchanged user input, host response, and persisted reviewer feature output", () => {
  const inputText = "please fix the bug of login now";
  const good = behaviorAssertions("happy_path", {
    interaction: interaction(inputText),
    inputText,
    reviewLog: `${REVIEW_RENDERING}\nnoun の修飾は名詞の前に置く\nfix → resolve`,
  });
  assert.equal(good[0].id, "feature_response");
  assert.ok(good[0].passed);
  for (const observation of [
    { interaction: interaction("rewritten prompt"), inputText, reviewLog: REVIEW_RENDERING },
    { interaction: interaction(inputText), inputText, reviewLog: "" },
    { interaction: { ...interaction(inputText), assistantText: "" }, inputText, reviewLog: REVIEW_RENDERING },
  ]) {
    assert.equal(behaviorAssertions("happy_path", observation)[0].passed, false);
  }
});

test("error path requires a handled malformed response and a prompt that still completed", () => {
  const inputText = "please fix the bug of login now";
  const good = behaviorAssertions("error_path", {
    interaction: interaction(inputText),
    inputText,
    statusMessage: "pi-lingua: on\nreviewed 0, skipped 1 (last skip: unparseable reviewer response)",
    failureNotification: "pi-lingua: the reviewer model did not return usable JSON",
    reviewerResponse: MALFORMED_REVIEWER_RESPONSE,
    extensionErrors: 0,
    reviewLogFiles: 0,
  });
  assert.equal(good[0].id, "handled_error");
  assert.ok(good[0].passed);
  for (const override of [
    { failureNotification: undefined },
    { reviewerResponse: "valid JSON, unrelated error" },
    { statusMessage: "reviewed 0, skipped 0" },
    { extensionErrors: 1 },
    { reviewLogFiles: 1 },
  ]) {
    assert.equal(behaviorAssertions("error_path", {
      interaction: interaction(inputText), inputText,
      statusMessage: "reviewed 0, skipped 1 (last skip: unparseable reviewer response)",
      failureNotification: "malformed response handled",
      reviewerResponse: MALFORMED_REVIEWER_RESPONSE,
      extensionErrors: 0,
      reviewLogFiles: 0,
      ...override,
    })[0].passed, false);
  }
});

test("reload requires second-process registration AND feature output AND natural clean shutdown", () => {
  const inputText = "please fix the bug of login now";
  const observation = {
    second: { commands, commandsSuccess: true, interaction: interaction(inputText) },
    inputText,
    reviewLogCount: 2,
    processes: [successfulProcess, successfulProcess],
    unhandledErrors: 0,
    extensionLoadErrors: 0,
  };
  const good = behaviorAssertions("reload_cleanup", observation);
  assert.deepEqual(good.map((item) => item.id), [
    "reloaded_extension_registered",
    "reloaded_feature_response",
    "clean_shutdown",
  ]);
  assert.ok(good.every((item) => item.passed));
  for (const override of [
    { second: { commands: [], commandsSuccess: true, interaction: interaction(inputText) } },
    { second: { commands, commandsSuccess: true, interaction: { ...interaction(inputText), assistantText: "" } } },
    { reviewLogCount: 1 },
    { processes: [{ ...successfulProcess, forced: true }, successfulProcess] },
    { unhandledErrors: 1 },
    { extensionLoadErrors: 1 },
  ]) {
    const failed = behaviorAssertions("reload_cleanup", { ...observation, ...override });
    assert.ok(failed.some((item) => !item.passed), JSON.stringify(override));
  }
});

test("native shell boundary requires exact SDK version output and clean process status", () => {
  assert.ok(behaviorAssertions("host_shell", { exit_code: 0, output: "1.2.0\r\n", expectedVersion: "1.2.0" })[0].passed);
  for (const observation of [
    { exit_code: 1, output: "1.2.0", expectedVersion: "1.2.0" },
    { exit_code: 0, output: "11.2.0", expectedVersion: "1.2.0" },
    { exit_code: 0, output: "1.2.0 but error", expectedVersion: "1.2.0" },
  ]) {
    assert.equal(behaviorAssertions("host_shell", observation)[0].passed, false);
  }
});
