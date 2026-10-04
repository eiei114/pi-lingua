# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

## [0.6.1] - 2026-10-05

### Changed

- All Lingua preferences are global-only. Legacy project blocks are ignored and left untouched;
  move desired values into the agent settings file explicitly.
- Already-open sessions follow shared toggles, reviewer models, effort, language, and sink settings.
  Idle widgets update within the 250 ms polling interval; pending outdated reviews are aborted
  and cannot restore an OFF widget or publish results using an old configuration.

## [0.6.0] - 2026-10-02

### Added

- `/lingua:off` and `/lingua:on` are saved to Pi's settings as `pi-lingua.enabled`, so the next
  session and any other project start from the same state. `/lingua:status` reports the settings file
  in use.
- `/lingua:model` and `/lingua:effort` save `reviewer.provider` / `reviewer.model` /
  `reviewer.thinkingLevel` instead of only lasting for the session. Choosing "Session model" or `off`
  removes those keys, which is what makes the reviewer fall back.

### Changed

- A value is written to the settings file that already sets that key, because a write to any other
  file would be shadowed by it. Keys no file sets go to the agent settings file, so a toggle reaches
  every project.
- An untrusted project's `.pi/settings.json` no longer changes pi-lingua behaviour, matching how Pi
  resolves settings. A command that would have to write there reports it and saves globally instead.

## [0.5.1] - 2026-09-30

### Changed

- Update `@earendil-works/pi-*` dependencies to `0.99.1`.

## [0.5.0] - 2026-09-26

### Added

- `/lingua:model` — Pi model catalog selector for the Reviewer Model (session override).
- `/lingua:effort` — Pi thinking selector for reviewer effort only (task-run thinking unchanged).
- Optional `pi-lingua.reviewer.thinkingLevel` in settings; `/lingua:status` shows current effort.

## [0.4.1] - 2026-09-25

### Changed

- Alternate neutral theme backgrounds and separate review blocks with an unfilled row in the widget
  and `/lingua:last` for clearer vertical contrast.

## [0.4.0] - 2026-09-23

### Changed

- Compact long URLs and file paths in the widget's source excerpts while keeping full text in
  `/lingua:last` and review logs.
- Use subtle, theme-aware background colors to distinguish review sections in the widget and detail
  entry.

## [0.3.0] - 2026-09-23

### Added

- Speaking pauses and IPA pronunciation for the full target-language rendering.
- Approximate Katakana readings alongside IPA when the configured native language is Japanese.
- Speaking guidance in the widget, detail view, transcript entry, and Markdown review log; older reviews remain supported.

## [0.2.0] - 2026-09-23

### Changed

- Display full review examples, translations, explanations, and vocabulary without ellipsis truncation.
- Wrap review content to the current terminal width and reflow it when the terminal is resized.

## [0.1.0] - 2026-09-21

### Added

- Non-blocking Prompt Review: the `input` hook always returns `continue`, and the reviewer call is
  never awaited, so no task ever waits for language feedback.
- In-process reviewer call through `ctx.modelRegistry.complete`, reusing Pi's resolved provider auth.
  No child process and no Windows shell shims.
- Language table and script classifier so the extension is language-agnostic. The target and native
  languages are settings, and prompts are classified locally before any model call.
- Eligibility filter that skips short replies, slash commands, code-only input, and unrecognized
  scripts without spending a token.
- Prompt-top review widget: the Target Language rendering, the changed fragments, one line explaining
  why, and up to two vocabulary suggestions.
- `markdown-log` Sink writing one markdown file per day with frontmatter. The default destination sits
  under Pi's agent directory, so no configuration is required, and pointing it at a notes folder makes
  the same implementation produce Obsidian-ready notes.
- `anki` Sink with AnkiConnect support and a TSV fallback that reports why it fell back, invoked only
  by explicit command so a deck never fills with cards the user did not choose.
- Commands: `/lingua:last`, `/lingua:card`, `/lingua:off`, `/lingua:on`, `/lingua:status`,
  `/lingua:configure`. None take inline arguments.
- CI covering typecheck, tests, workflow guardrails, an `npm pack --dry-run`, and a publish guard that
  keeps a stored npm token out of the release path.
- Review guardrails that accept both `npm pack --json` output shapes (`[ … ]` on npm 11, an object
  keyed by package name on npm 12) so validation gives the same answer in CI and in the publish job.
