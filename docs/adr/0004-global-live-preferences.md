# 0004-global-live-preferences

Supersedes ADR-0003's project-owner routing and session-only overrides.

## Decision

All `pi-lingua` preferences live in Pi's agent-global settings file. Project blocks are ignored,
not silently migrated or deleted. Commands always write globally. Running sessions do not retain
toggle/model/effort overrides that can shadow another session's changes.

Input and status paths read current settings. A non-persistent 250 ms file poll clears stale
widgets and aborts pending work on a semantic configuration change, including atomic replacements.
Shutdown disposes the poll. Completion rechecks configuration and revision before publishing.
Changing a reviewer affects the next eligible prompt; it does not rerun old prompts.

The "Session model" fallback remains a shared policy, not a globally pinned model ID. Separate
agent directories are separate preference domains. No provider auth or Task Run settings change.

## Rationale

The user explicitly requested shared toggles, reviewer models and other preferences, including
changes during already-open sessions. Project ownership and session overrides caused divergent
behavior. In-flight completion could also restore a widget after OFF.

## Non-goals

Cross-machine sync, installing/releasing the change, resizing the review widget, and restarting
already-running Task Runs are separate concerns.
