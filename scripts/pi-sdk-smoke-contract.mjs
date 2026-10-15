export const VERIFICATION_CONTRACT = "pi-sdk-behavior-v2";
export const SDK_VERSIONS = {
  "@earendil-works/pi-agent-core": "1.2.0",
  "@earendil-works/pi-ai": "1.2.0",
  "@earendil-works/pi-coding-agent": "1.2.0",
  "@earendil-works/pi-tui": "1.2.0",
};
export const REQUIRED_COMMANDS = [
  "lingua:last",
  "lingua:card",
  "lingua:off",
  "lingua:on",
  "lingua:status",
  "lingua:configure",
  "lingua:model",
  "lingua:effort",
];
export const HOST_RESPONSE = "PI_LINGUA_SMOKE_HOST_RESPONSE";
export const MALFORMED_REVIEWER_RESPONSE = "deliberately malformed reviewer response";
export const REVIEW_RENDERING = "Please fix the login bug now.";
export const UNHANDLED_ERROR_PATTERN = /UnhandledPromiseRejection|uncaught exception|unhandled rejection|shutdown error|extension_error/i;
export const EXTENSION_LOAD_ERROR_PATTERN = /Failed to load extension|Error loading extension|Cannot load extension/i;

export function parseJsonLines(output) {
  return output.split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

function extensionCommands(records) {
  const reply = records.find((record) => record?.type === "response" && record.command === "get_commands");
  return reply?.success === true && Array.isArray(reply.data?.commands)
    ? reply.data.commands.filter((item) => item.source === "extension").map((item) => item.name)
    : [];
}

function notification(records, includes) {
  return records.find((record) => record?.type === "extension_ui_request"
    && record.method === "notify" && typeof record.message === "string"
    && record.message.includes(includes));
}

function actual(assertions, id, expected, observed, passed) {
  assertions.push({ id, expected, observed: JSON.stringify(observed), passed: passed === true });
}

function commandInventoryPasses(commands) {
  return REQUIRED_COMMANDS.every((name) => commands.includes(name));
}

function interactionPasses(interaction, inputText) {
  return interaction?.prompt?.success === true
    && interaction.prompt.data?.disposition === "started"
    && interaction.userText === inputText
    && interaction.assistantText === HOST_RESPONSE;
}

export function behaviorAssertions(name, observation) {
  const assertions = [];
  const commands = observation.commands ?? [];

  if (name === "extension_load") {
    actual(assertions, "extension_registered", "The actual Pi host lists every pi-lingua slash command",
      commands, observation.commandsSuccess === true && commandInventoryPasses(commands));
  } else if (name === "happy_path") {
    const interaction = observation.interaction;
    const responseOk = interactionPasses(interaction, observation.inputText);
    const reviewOk = typeof observation.reviewLog === "string"
      && observation.reviewLog.includes(REVIEW_RENDERING)
      && observation.reviewLog.includes("noun の修飾は名詞の前に置く")
      && observation.reviewLog.includes("resolve");
    actual(assertions, "feature_response",
      "Pi accepts the unchanged prompt, returns the deterministic host answer, and pi-lingua persists its real reviewer result",
      { interaction, reviewLogContainsExpectedReview: reviewOk }, responseOk && reviewOk);
  } else if (name === "error_path") {
    const interaction = observation.interaction;
    const handled = interactionPasses(interaction, observation.inputText)
      && typeof observation.statusMessage === "string"
      && observation.statusMessage.includes("reviewed 0, skipped 1 (last skip: unparseable reviewer response)")
      && Boolean(observation.failureNotification)
      && observation.reviewerResponse === MALFORMED_REVIEWER_RESPONSE
      && observation.extensionErrors === 0
      && observation.reviewLogFiles === 0;
    actual(assertions, "handled_error",
      "Malformed offline reviewer JSON is reported and skipped while the prompt still reaches the actual Pi host",
      { interaction, statusMessage: observation.statusMessage ?? null,
        failureNotification: observation.failureNotification ?? null,
        reviewerResponse: observation.reviewerResponse ?? null,
        extensionErrors: observation.extensionErrors, reviewLogFiles: observation.reviewLogFiles }, handled);
  } else if (name === "reload_cleanup") {
    const second = observation.second ?? {};
    const reloadedCommands = second.commands ?? [];
    actual(assertions, "reloaded_extension_registered",
      "A second actual Pi process registers the full pi-lingua command surface after the first shuts down",
      reloadedCommands, second.commandsSuccess === true && commandInventoryPasses(reloadedCommands));
    const reloadedFeatureOk = interactionPasses(second.interaction, observation.inputText)
      && observation.reviewLogCount >= 2;
    actual(assertions, "reloaded_feature_response",
      "The second Pi process handles a fresh prompt and appends a second real review after reload",
      { interaction: second.interaction ?? null, matchingReviews: observation.reviewLogCount }, reloadedFeatureOk);
    const processObservations = Array.isArray(observation.processes)
      ? observation.processes.map((item) => ({
        exit_code: item.exit_code,
        signal: item.signal,
        forced: item.forced,
        unhandled_errors: UNHANDLED_ERROR_PATTERN.test(item.output ?? ""),
        extension_load_errors: EXTENSION_LOAD_ERROR_PATTERN.test(item.output ?? ""),
      }))
      : [];
    const clean = processObservations.length === 2
      && processObservations.every((item) => item.exit_code === 0 && item.signal === null && !item.forced
        && !item.unhandled_errors && !item.extension_load_errors)
      && observation.unhandledErrors === 0
      && observation.extensionLoadErrors === 0;
    actual(assertions, "clean_shutdown",
      "Both actual Pi processes exit naturally with code 0 and no extension-load, unhandled, or shutdown errors",
      processObservations, clean);
  } else if (name === "host_shell") {
    const expected = observation.expectedVersion;
    actual(assertions, "native_shell_boundary",
      "The native host shell launches the locally pinned Pi CLI and emits its exact SDK version",
      { exit_code: observation.exit_code, output: observation.output?.trim() ?? "", expectedVersion: expected },
      observation.exit_code === 0 && observation.output?.trim() === expected);
  } else {
    throw new Error(`Unknown smoke case: ${name}`);
  }

  return assertions;
}

export function casePassed(assertions, processResults = []) {
  return assertions.length > 0
    && assertions.every((item) => item.passed === true)
    && processResults.every((item) => item.exit_code === 0 && item.signal === null && !item.forced
      && !UNHANDLED_ERROR_PATTERN.test(item.output ?? "")
      && !EXTENSION_LOAD_ERROR_PATTERN.test(item.output ?? ""));
}
