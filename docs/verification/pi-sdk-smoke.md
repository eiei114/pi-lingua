# Pi SDK compatibility smoke (pi-lingua)

`npm run smoke:pi` exercises the extension in isolated subprocesses using the exact
SDK versions pinned in `package.json`; `pi-sdk-smoke.json` records the versions
and observations from the last run. The CI workflow runs
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

The Pi SDK 1.5.0 template baseline (DOT-3243) is done and merged as
[PR #141](https://github.com/eiei114/pi-extension-template/pull/141) at exact
HEAD `e280e806c0e26f7ff4dd98627091c3cb4c9397b3`; its independent review and
Windows runtime-smoke evidence are recorded on the baseline issue. This package
reuses the baseline's `docs/pi-sdk-compatibility.md` guidance and behavior-v2
actual-host smoke/report pattern, while checking pi-lingua-specific feature
responses instead of copying template fixture assertions.

The [Pi v1.5.0 release notes](https://github.com/earendil-works/pi/releases/tag/v1.5.0)
move tool argument validation to `@earendil-works/pi-schema`: TypeBox constructs
outside JSON Schema no longer enforce tool arguments, and loosely typed values may
be coerced before validation. The pi-ai npm package also no longer re-exports
TypeBox. pi-lingua does not define tool argument schemas or use TypeBox/`StringEnum`,
so neither change requires a source migration. The
existing public peer dependency wildcards remain unchanged. The exact SDK 1.5.0
development pins typecheck this package's used APIs, and the actual-host smoke
verifies only the five paths listed below. The interactive `/lingua:model` and
`/lingua:effort` selectors are covered by typecheck and unit tests, not by the
actual-host smoke.

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
