# Roadmap

> Living roadmap for `pi-lingua`. Update it whenever a release ships, a major item is resolved, or
> the seed backlog is exhausted.

Status snapshot date: **2026-09-21**.

---

## 1. Current status

| Aspect | State |
|---|---|
| Version | `0.1.0` |
| Published to npm | not yet — first Trusted Publisher setup pending |
| Stage | v1 implementation complete, awaiting first publish |
| Language pairs | target / native configured by settings; English and Japanese are the defaults |
| Sinks | `markdown-log` (auto), `anki` (manual) |

## 2. Invariants (do not regress)

1. **A Prompt Review never blocks or rewrites a Task Run.** The `input` handler returns `continue`
   unconditionally and the reviewer call is never awaited. `tests/extension.test.mjs` asserts the
   handler returns while the reviewer promise is still unresolved — that test is the guard.
   See [ADR-0001](adr/0001-review-never-blocks-the-task-run.md).
2. **The reviewer runs in-process.** No child `pi` process. See
   [ADR-0002](adr/0002-in-process-reviewer-call.md).
3. **Anki never receives a card the user did not ask for.** The `anki` sink stays `manual`.
4. **A skipped prompt is explainable.** `/lingua:status` reports the reason for the most recent skip.

## 3. Next candidates

| Candidate | Why | Notes |
|---|---|---|
| First npm publish | The package is not installable until Trusted Publishing is configured | See [release.md](release.md) |
| Reviewer model routing guidance | A slow or reasoning-heavy Reviewer Model is the only way latency can regress | Document measured latency per provider |
| `pi-widget-host` interop | The prompt-top slot is shared when `pi-widget-host` is installed; this widget would compete for it | Register as a core-enabled provider, or fall back to `placement: "belowEditor"` |
| Assistant-output review | Users will ask to review replies, not just prompts | Out of scope in v1; needs its own latency story |
| Sink registry protocol | Other packages may want to receive reviews | Deliberately deferred until a second consumer exists |

## 4. Known constraints

- **No per-request thinking level.** `ModelRegistry` exposes only the API-specific `complete()`, so
  `reasoning` cannot be pinned per review. Latency is controlled by choosing a fast Reviewer Model
  instead. `lib/model.ts` is the single place this would change.
- **All-kanji prompts are ambiguous** between Japanese and Chinese. The classifier picks the language
  that claims `han`, which yields a harmless extra translation rather than a missed review.
- **Third-language prompts are skipped** rather than guessed at.
