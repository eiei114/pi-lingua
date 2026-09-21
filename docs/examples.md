# Examples

Every command takes no inline arguments. Run it, read the result.

## A Target Language prompt gets a correction

```
fix the bug of login
```

```
EN review
- the bug of login
+ the login bug
noun の修飾は前置が自然

◆ vocab
  fix → resolve  動詞の強度
  bug → defect  形式語
```

The agent still receives `fix the bug of login`, verbatim and immediately.

## A native-language prompt gets the translation

```
ログインのバグを直して
```

```
JA → EN
> ログインのバグを直して
+ Fix the login bug
動詞で始めると指示が明確
```

This is the highest-value case: you were going to write the sentence anyway, so producing it in the
Target Language costs you nothing extra.

## Prompts that are skipped

No model call happens for any of these:

| Prompt | Why |
|---|---|
| `ok` | shorter than `minWords` |
| `/lingua:off` | slash command |
| ```` ```ts … ``` ```` | code, no prose left |
| `исправить ошибку` | dominant script is neither the target nor the native language |

Run `/lingua:status` to see how many prompts were reviewed, how many were skipped, and the reason for
the most recent skip.

## Reading the full review later

```
/lingua:last
```

Writes a transcript entry with the complete review. The entry renders in the TUI and does **not** enter
the model's context, so it costs nothing on later turns.

## Sending vocabulary to Anki

```
/lingua:card
```

Reports one of:

```
anki: written — added 2 note(s) to English::PromptReview: fix, bug
anki: written /home/you/.pi/agent/lingua/anki-cards.tsv — wrote 2 card row(s) as TSV; AnkiConnect did not answer at http://127.0.0.1:8765 (fetch failed); install and start the AnkiConnect add-on to push directly
anki: skipped — this review has no vocabulary suggestions to add
```

The fallback is deliberate: a review that silently never reaches the deck is worse than an explicit
"install the add-on".

## Turning it off for a while

```
/lingua:off
```

Stops reviewing and clears the widget. `/lingua:on` resumes.

## Pointing the log at an Obsidian folder

```json
{
  "pi-lingua": {
    "sinks": { "reviewLog": { "dir": "4_Project/English-Study/Review" } }
  }
}
```

The same `markdown-log` sink now writes vault notes. One file per day:

```markdown
---
date: 2026-09-21
target_language: English
native_language: Japanese
---

## 09:12 · Japanese → English

- **wrote:** ログインのバグを直して
- **English:** Fix the login bug
- **note:** 動詞で始めると指示が明確
- **vocabulary:**
  - fix → resolve (強度)
```

## Learning a language other than English

```json
{
  "pi-lingua": {
    "targetLanguage": "fr",
    "nativeLanguage": "en",
    "explainIn": "native",
    "sinks": { "anki": { "deck": "French::PromptReview" } }
  }
}
```

Language values accept either a tag (`fr`) or a name (`French`). Supported languages are listed in
`lib/languages.ts`; each entry declares the scripts used to tell the two languages apart locally.
