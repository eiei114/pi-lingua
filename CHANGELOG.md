# Changelog

All notable changes to this project will be documented in this file.

This project follows semantic versioning.

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
