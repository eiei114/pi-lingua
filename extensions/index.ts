import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { registerLinguaCommands, type LinguaStats } from "../lib/commands.ts";
import { loadLinguaConfig } from "../lib/config.ts";
import { evaluateEligibility } from "../lib/eligibility.ts";
import { requestReviewerCompletion, resolveReviewerTarget } from "../lib/model.ts";
import { renderReviewWidget, renderSpeakingGuide } from "../lib/render.ts";
import { buildReviewerPrompt, parseReviewResponse, type PromptReview } from "../lib/review.ts";
import { runSinks } from "../lib/sinks/dispatch.ts";
import { describeError, type SinkResult } from "../lib/sinks/types.ts";

export const REVIEW_WIDGET_KEY = "pi-lingua:review";
export const REVIEW_ENTRY_TYPE = "pi-lingua-review";

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let lastReview: PromptReview | undefined;
  let stats: LinguaStats = {
    reviewed: 0,
    skipped: 0,
    lastSkipReason: undefined,
    reviewerLabel: undefined,
    lastSinkResults: [],
  };

  pi.registerEntryRenderer<PromptReview>(REVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const review = entry.data;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));

    if (!review) {
      box.addChild(new Text(theme.fg("dim", "pi-lingua review (no data)")));
      return box;
    }

    const header =
      review.language === "native"
        ? `${review.nativeLanguageName} → ${review.targetLanguageName}`
        : `${review.targetLanguageName} review`;
    box.addChild(new Text(theme.bold(`pi-lingua · ${header}`)));
    box.addChild(new Text(`${theme.fg("dim", "wrote")} ${review.prompt}`));
    box.addChild(new Text(`${theme.fg("accent", review.targetLanguageName)} ${review.rendering}`));
    for (const line of renderSpeakingGuide(review)) box.addChild(new Text(line));

    if (review.changes.length > 0) {
      for (const change of review.changes) {
        box.addChild(
          new Text(`${theme.fg("error", `- ${change.from}`)}\n${theme.fg("success", `+ ${change.to}`)}`),
        );
      }
    }

    if (review.note) box.addChild(new Text(theme.fg("muted", review.note)));

    if (review.vocabulary.length > 0) {
      for (const item of review.vocabulary) {
        const gloss = item.gloss ? theme.fg("dim", `  ${item.gloss}`) : "";
        box.addChild(new Text(`◆ ${item.from} → ${item.to}${gloss}`));
      }
    }

    if (expanded) {
      box.addChild(new Text(theme.fg("dim", `model ${review.createdAt}`)));
    }

    return box;
  });

  async function reviewPrompt(text: string, ctx: ExtensionContext): Promise<void> {
    const config = loadLinguaConfig(ctx.cwd);
    const eligibility = evaluateEligibility(text, config);

    if (!eligibility.eligible) {
      stats = { ...stats, skipped: stats.skipped + 1, lastSkipReason: eligibility.reason };
      return;
    }

    const target = resolveReviewerTarget(ctx, config);
    if (!target) {
      stats = {
        ...stats,
        skipped: stats.skipped + 1,
        lastSkipReason: "no reviewer model available",
      };
      return;
    }
    stats = { ...stats, reviewerLabel: target.label };

    const prompt = buildReviewerPrompt({ text, language: eligibility.language, config });

    let raw: string;
    try {
      raw = await requestReviewerCompletion(ctx, target, prompt);
    } catch (error) {
      stats = { ...stats, skipped: stats.skipped + 1, lastSkipReason: "reviewer call failed" };
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-lingua review failed: ${describeError(error)}`, "warning");
      }
      return;
    }

    const review = parseReviewResponse(raw, {
      prompt: text,
      language: eligibility.language,
      config,
    });

    if (!review) {
      stats = { ...stats, skipped: stats.skipped + 1, lastSkipReason: "unparseable reviewer response" };
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-lingua: the reviewer model did not return usable JSON. Run /lingua:status to check the Reviewer Model.",
          "warning",
        );
      }
      return;
    }

    lastReview = review;
    stats = { ...stats, reviewed: stats.reviewed + 1, lastSkipReason: undefined };

    if (ctx.hasUI) {
      ctx.ui.setWidget(
        REVIEW_WIDGET_KEY,
        () => ({
          render: (width) => renderReviewWidget(review, { explainIn: config.explainIn, width }),
          invalidate: () => {},
        }),
      );
    }

    const results: SinkResult[] = await runSinks(review, config, "auto");
    stats = { ...stats, lastSinkResults: results };

    if (ctx.hasUI) {
      for (const result of results) {
        if (result.status === "failed") {
          ctx.ui.notify(
            `pi-lingua sink "${result.sinkId}" failed: ${result.detail ?? "unknown error"}`,
            "warning",
          );
        }
      }
    }
  }

  pi.on("input", async (event, ctx) => {
    // Every early return here is `continue`: this handler observes the prompt and must never
    // rewrite it or hold up the Task Run (ADR-0001).
    if (!enabled) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };

    // Deliberately not awaited. The review is a side lane; the prompt goes to the agent now.
    void reviewPrompt(event.text, ctx).catch(() => {
      // reviewPrompt already reports its own failures; this only stops an unhandled rejection.
    });

    return { action: "continue" };
  });

  registerLinguaCommands(pi, {
    getConfig: (ctx) => loadLinguaConfig(ctx.cwd),
    isEnabled: () => enabled,
    setEnabled: (value) => {
      enabled = value;
    },
    getLastReview: () => lastReview,
    clearWidget: (ctx) => {
      if (ctx.hasUI) ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    },
    appendDetail: (review) => {
      pi.appendEntry(REVIEW_ENTRY_TYPE, review);
    },
    runManualSinks: (review, ctx) => runSinks(review, loadLinguaConfig(ctx.cwd), "manual"),
    getStats: () => stats,
  });
}
