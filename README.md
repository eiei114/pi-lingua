# pi-lingua

[![CI](https://github.com/eiei114/pi-lingua/actions/workflows/ci.yml/badge.svg)](https://github.com/eiei114/pi-lingua/actions/workflows/ci.yml)
[![Publish](https://github.com/eiei114/pi-lingua/actions/workflows/publish.yml/badge.svg)](https://github.com/eiei114/pi-lingua/actions/workflows/publish.yml)
[![npm version](https://img.shields.io/npm/v/pi-lingua.svg)](https://www.npmjs.com/package/pi-lingua)
[![npm downloads](https://img.shields.io/npm/dm/pi-lingua.svg)](https://www.npmjs.com/package/pi-lingua)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi package](https://img.shields.io/badge/pi-package-purple.svg)](https://pi.dev/packages)
[![Trusted Publishing](https://img.shields.io/badge/npm-Trusted%20Publishing-blue.svg)](docs/release.md)

> Review the language you write to Pi while the agent does the real work.

## What this is

You already type dozens of messages a day into Pi. Those messages are the densest language practice
material you own, and today they are consumed as input and thrown away.

`pi-lingua` reviews them on a side lane. Every prompt you send also gets a **Prompt Review**: the
Target Language rendering of what you meant, the parts that changed, one line saying why, and up to
two vocabulary suggestions. It appears above the prompt editor while the agent is working.

Two things it never does:

- **It never blocks the task.** The prompt goes to the agent immediately, unchanged. The review runs
  in parallel and lands whenever it lands.
- **It never rewrites your prompt.** What you wrote is what the agent reads. The corrected version is
  shown and saved, never substituted.

## Features

- **Speaking guidance.** `Speak` marks natural pauses with `/`; `IPA` gives model-generated
  pronunciation. When `nativeLanguage` resolves to Japanese (for example `ja`, `ja-JP`, or
  `Japanese`), an approximate Katakana reading is shown too, never instead of IPA.
  Guidance covers the full target rendering and is saved in review logs. Missing or malformed
  guidance is omitted without blocking the task; older reviews still display normally.
  Katakana cannot represent all target-language sounds and is only a reading aid.

- **Non-blocking by construction.** The `input` hook always returns `continue`, and the reviewer call
  is never awaited. See [ADR-0001](docs/adr/0001-review-never-blocks-the-task-run.md).
- **In-process review.** One call through Pi's own model registry, reusing resolved provider auth. No
  child process, no Windows shell shims. See [ADR-0002](docs/adr/0002-in-process-reviewer-call.md).
- **Language-agnostic.** Set a target and a native language. English/Japanese is the default, not an
  assumption.
- **Two directions.** Write in the Target Language and get a correction. Write in your native
  language and get the Target Language rendering — production practice on the prompts you were
  writing anyway.
- **Cheap where it can be.** Short acknowledgements, slash commands, and code paste are filtered out
  locally, before any model call.
- **Sinks.** The review log is plain markdown on disk, so pointing it at an Obsidian folder makes it
  a vault note. Vocabulary reaches Anki on demand, never automatically.

## Install

```bash
pi install npm:pi-lingua
```

## Quick start

Install, restart Pi, and send any normal prompt in your target language:

```
fix the bug of login
```

While the agent works, the review appears above the editor:

```
EN review
- the bug of login
+ the login bug
noun の修飾は前置が自然

◆ vocab
  fix → resolve  動詞の強度
```

Write in your native language instead and you get the translation:

```
JA → EN
> ログインのバグを直して
+ Fix the login bug
動詞で始めると指示が明確
```

No configuration is required. Out of the box, reviews are written to Pi's own agent directory, which
exists on every machine.

## Commands

Arguments are never typed inline. Every command either reports immediately or reads what it needs from
the current session.

| Command | What it does |
|---|---|
| `/lingua:last` | Print the full text of the most recent Prompt Review into the transcript |
| `/lingua:card` | Send the most recent vocabulary suggestions to Anki |
| `/lingua:off` | Stop reviewing and clear the widget |
| `/lingua:on` | Resume reviewing |
| `/lingua:status` | Review counts, sink state, and the Reviewer Model in use |
| `/lingua:configure` | Print the settings block to paste into `.pi/settings.json` |

`/lingua:last` writes a transcript entry, not a message. It is rendered for you and is **not** sent to
the model, so asking for a review never costs context.

## Settings

Project settings (`.pi/settings.json`) override agent settings, which override the defaults.

```json
{
  "pi-lingua": {
    "targetLanguage": "en",
    "nativeLanguage": "ja",
    "explainIn": "native",
    "minWords": 3,
    "minChars": 6,
    "reviewNativeLanguagePrompts": true,
    "reviewer": { "provider": "deepseek", "model": "deepseek-chat" },
    "sinks": {
      "reviewLog": { "enabled": true, "dir": "~/.pi/agent/lingua/reviews" },
      "anki": {
        "enabled": false,
        "mode": "ankiconnect",
        "deck": "English::PromptReview",
        "endpoint": "http://127.0.0.1:8765",
        "tsvPath": "~/.pi/agent/lingua/anki-cards.tsv"
      }
    }
  }
}
```

| Key | Meaning |
|---|---|
| `targetLanguage` | The language you are learning. Accepts a tag (`en`) or a name (`English`). |
| `nativeLanguage` | The language you think in. Source of translations. |
| `explainIn` | `native` or `target` — the language of the one-line reason. |
| `minWords` | Minimum word count for space-delimited languages. |
| `minChars` | Minimum character count for languages written without spaces. |
| `reviewNativeLanguagePrompts` | Set `false` to review only Target Language prompts. |
| `reviewer` | The Reviewer Model. Omit to use the session model. |
| `sinks.reviewLog.dir` | Where the markdown review log goes. Point it at an Obsidian folder to get vault notes. |
| `sinks.anki.enabled` | Off by default. Anki only ever receives cards you ask for. |

### Making the review log an Obsidian note

Point the review log at any folder in your vault:

```json
{ "pi-lingua": { "sinks": { "reviewLog": { "dir": "4_Project/English-Study/Review" } } } }
```

The same sink writes it. One file per day, with frontmatter, so it is readable as a note and
greppable as text.

### Anki

`/lingua:card` pushes the current vocabulary suggestions. With `mode: "ankiconnect"` (the default) it
talks to the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on on `127.0.0.1:8765`.
If the add-on is not installed or Anki is not running, the cards are written to `tsvPath` instead and
the command tells you why — the review is never lost silently. `mode: "tsv"` skips the add-on
entirely and always writes the file for Anki's importer (Front / Back / Tags columns).

## Package contents

| Path | Purpose |
|---|---|
| `extensions/` | Pi extension entrypoint |
| `lib/` | Config, language tables, eligibility, reviewer call, rendering, sinks |
| `docs/` | Release notes and design records |

## Development

```bash
npm install
npm run ci
```

`npm run ci` runs typecheck, the test suite, the workflow guardrails, an `npm pack --dry-run`, and the
publish guard that keeps a stored npm token out of the release path.

The suite never touches the network. The reviewer call is injected, sinks write to temp directories,
and AnkiConnect is probed against an unreachable port on purpose.

## Release

Version bump and push; `auto-release.yml` tags the commit and dispatches `publish.yml`, which
publishes through npm Trusted Publishing. See [`docs/release.md`](docs/release.md).

## Security

Pi packages run with your local permissions. Review any extension before installing it.

`pi-lingua` reads your prompts, writes markdown files, and makes one model call per eligible prompt.
It can also POST to a local AnkiConnect endpoint. It sends nothing anywhere else and runs no shell
commands. See [`SECURITY.md`](SECURITY.md).

## Links

- npm: https://www.npmjs.com/package/pi-lingua
- GitHub: https://github.com/eiei114/pi-lingua
- Issues: https://github.com/eiei114/pi-lingua/issues

## License

MIT
