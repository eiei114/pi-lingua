# Pi SDK compatibility smoke (pi-lingua)

`npm run smoke:pi` exercises the extension in isolated subprocesses using the exact
SDK versions recorded in `pi-sdk-smoke.json`. The CI workflow runs
`npm run ci` on both Linux and Windows, so `host_shell` checks the native shell
boundary on each platform.

The smoke starts the installed `@earendil-works/pi-coding-agent` CLI with RPC mode,
loads `extensions/index.ts`, and submits prompts through the real input hook. A
loopback-only deterministic OpenAI-compatible server supplies a fixed host response
and a fixed reviewer response; the error case deliberately supplies malformed
reviewer content. This avoids paid inference and external provider access. It does
not mock Pi imports, the CLI process, extension registration/lifecycle, model
runtime, prompt hook, reviewer parser, or markdown sink. Each RPC process has a
15-second deadline, must exit naturally, and is checked for extension-load,
unhandled, and shutdown errors. Settings, auth, sessions, and logs are isolated in a
temporary `PI_CODING_AGENT_DIR`; production/global Pi settings are not read or
changed.

## Baseline reuse and API review

The Pi SDK 1.2.0 template baseline (DOT-2415) is done and merged as
[PR #131](https://github.com/eiei114/pi-extension-template/pull/131) at exact
HEAD `4b0554151161eae665aa2cdc845a2d7df40e4781`; that HEAD was independently
approved and its runtime-verification receipt accepted. This package reuses its
frozen SDK pins, compatibility notes, and behavior-v2 actual-host smoke/report
pattern, while checking pi-lingua-specific feature responses rather than copying
template fixture assertions. Peer dependency wildcards remain unchanged.

Compared this package's extension, UI/TUI, settings, and model-runtime calls with
the baseline `docs/pi-sdk-compatibility.md` and the SDK 1.2.0 release notes. The
release changes `before_agent_start` event fields to a `messageType` union, but
pi-lingua does not use that event. No used API is deprecated or removed, so no
speculative source rewrite was needed; exact-version typecheck and the real host
smoke verify the current usage.

The five cases verify:

- `extension_load`: the actual host discovers all eight pi-lingua slash commands.
- `happy_path`: the prompt remains unchanged, the host responds, and the reviewer
  result is written to the markdown log.
- `error_path`: malformed reviewer JSON is surfaced as a handled skip while the
  user's prompt still completes normally.
- `reload_cleanup`: a second real Pi process registers the extension, handles a new
  prompt, appends another review, and both processes exit cleanly.
- `host_shell`: the native shell launches this checkout's pinned CLI and returns
  the exact SDK version.

`docs/verification/pi-sdk-smoke.json` is generated from the actual executions and
contains each command, exit status, assertions, and captured RPC/provider output.
The harness regression tests also prove that missing reload responses and invalid
host-shell versions fail the corresponding assertions.
