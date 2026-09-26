# 0002-in-process-reviewer-call

Prompt Review は `ctx.modelRegistry.complete` を in-process で呼び、子 `pi` プロセスを spawn しない。

## 理由

この vault の家風パターン（`pi-git-delegate`、`examples/extensions/subagent/`）は子 `pi` を spawn して JSON mode で受け取る。隔離は完璧だが、起動に3〜8秒、加えて system prompt と skill のロード分（数千トークン）を毎回捨てる。

Prompt Review は入力がプロンプト1件、出力が6〜8行で、隔離されたコンテキストを必要としない。子プロセスのオーバーヘッドが便益を上回る条件が揃っていない。

子プロセス経路は Windows の npm shim で `spawn pi ENOENT` を踏む。`pi-spawnkit` が存在する理由がこれで、in-process 呼び出しはこの地雷を構造的に踏まない。

ADR-0001 の非ブロッキングを守るには1〜2秒で返る必要があり、子プロセス起動はその予算を単独で食い潰す。

## 制約（実装時に判明）

Reviewer 呼び出しは `lib/model.ts` に集約する。thinking なしは `complete()`、effort 指定時は `streamSimple(..., { reasoning }).result()` を使う（タスク側の thinking には触れない）。

遅延が問題なら `/lingua:model` で軽い Reviewer Model を選ぶか、`/lingua:effort` で `off` / `low` に下げる。永続化は `pi-lingua.reviewer.thinkingLevel` か TUI のセッション override。

## 代替案

- **子 `pi` を spawn する subagent パターン**: 隔離と実績はあるが、この用途では起動コストが支配的になる。
- **セッションと同じモデル・同じコンテキストで評価する**: 現在のセッションは thinking `max` なので、評価のたびに推論コストと5〜20秒の遅延が乗る。ADR-0001 と両立しない。
