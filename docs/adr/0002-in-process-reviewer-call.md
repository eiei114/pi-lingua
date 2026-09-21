# 0002-in-process-reviewer-call

Prompt Review は `ctx.modelRegistry.complete` を in-process で呼び、子 `pi` プロセスを spawn しない。

## 理由

この vault の家風パターン（`pi-git-delegate`、`examples/extensions/subagent/`）は子 `pi` を spawn して JSON mode で受け取る。隔離は完璧だが、起動に3〜8秒、加えて system prompt と skill のロード分（数千トークン）を毎回捨てる。

Prompt Review は入力がプロンプト1件、出力が6〜8行で、隔離されたコンテキストを必要としない。子プロセスのオーバーヘッドが便益を上回る条件が揃っていない。

子プロセス経路は Windows の npm shim で `spawn pi ENOENT` を踏む。`pi-spawnkit` が存在する理由がこれで、in-process 呼び出しはこの地雷を構造的に踏まない。

ADR-0001 の非ブロッキングを守るには1〜2秒で返る必要があり、子プロセス起動はその予算を単独で食い潰す。

## 制約（実装時に判明）

`ModelRegistry` が公開するのは API 固有型の `complete()` だけで、provider 中立の `completeSimple` / `streamSimple` は 0.84.4 では公開されていない。そのため **per-request の thinking level を指定できず**、`reasoning`（`SimpleStreamOptions` にのみ存在）は API 固有 options では受理されない。

遅延は「速い Reviewer Model を選ぶ」ことで制御する。これは設定で差し替え可能で、`lib/model.ts` が唯一の接触点。provider 中立の経路が将来公開されたら、そこだけ変える。ストリーミング不要（1回の完結した応答が欲しい）なので `complete` は機能的にも適切。

## 代替案

- **子 `pi` を spawn する subagent パターン**: 隔離と実績はあるが、この用途では起動コストが支配的になる。
- **セッションと同じモデル・同じコンテキストで評価する**: 現在のセッションは thinking `max` なので、評価のたびに推論コストと5〜20秒の遅延が乗る。ADR-0001 と両立しない。
