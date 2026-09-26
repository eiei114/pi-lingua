import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { registerLinguaCommands, type LinguaStats } from "../lib/commands.ts";
import { loadLinguaConfig } from "../lib/config.ts";
import {
  createEmptyReviewerOverrides,
  type ReviewerOverrides,
} from "../lib/reviewer-overrides.ts";
import { evaluateEligibility } from "../lib/eligibility.ts";
import { requestReviewerCompletion, resolveReviewerTarget } from "../lib/model.ts";
import {
  renderReviewWidgetSections,
  renderSpeakingGuide,
  type ReviewWidgetSectionKind,
} from "../lib/render.ts";
import { buildReviewerPrompt, parseReviewResponse, type PromptReview } from "../lib/review.ts";
import { runSinks } from "../lib/sinks/dispatch.ts";
import { describeError, type SinkResult } from "../lib/sinks/types.ts";

export const REVIEW_WIDGET_KEY = "pi-lingua:review";
export const REVIEW_ENTRY_TYPE = "pi-lingua-review";

function sectionBackground(kind: ReviewWidgetSectionKind) {
  switch (kind) {
    case "source":
      return "userMessageBg";
    case "rendering":
      return "customMessageBg";
    case "changes":
      return "toolErrorBg";
    case "speaking":
      return "toolPendingBg";
    case "note":
      return "selectedBg";
    case "vocabulary":
      return "toolSuccessBg";
  }
}

function addReviewSection(
  container: Container,
  theme: Theme,
  kind: ReviewWidgetSectionKind,
  content: string,
): void {
  const box = new Box(1, 0, (text) => theme.bg(sectionBackground(kind), text));
  box.addChild(new Text(content, 0, 0));
  container.addChild(box);
}

function createReviewWidget(review: PromptReview, theme: Theme): Container {
  const container = new Container();
  for (const section of renderReviewWidgetSections(review)) {
    addReviewSection(container, theme, section.kind, section.lines.join("\n"));
  }
  return container;
}

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let reviewerOverrides: ReviewerOverrides = createEmptyReviewerOverrides();
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
    const container = new Container();

    if (!review) {
      addReviewSection(container, theme, "source", theme.fg("dim", "pi-lingua review (no data)"));
      return container;
    }

    const header =
      review.language === "native"
        ? `${review.nativeLanguageName} → ${review.targetLanguageName}`
        : `${review.targetLanguageName} review`;
    addReviewSection(
      container,
      theme,
      "source",
      `${theme.bold(`pi-lingua · ${header}`)}\n${theme.fg("dim", "wrote")} ${review.prompt}`,
    );
    addReviewSection(
      container,
      theme,
      "rendering",
      `${theme.fg("accent", review.targetLanguageName)} ${review.rendering}`,
    );

    const speaking = renderSpeakingGuide(review);
    if (speaking.length > 0) addReviewSection(container, theme, "speaking", speaking.join("\n"));

    if (review.changes.length > 0) {
      const changes: string[] = [];
      for (const change of review.changes) {
        changes.push(theme.fg("error", `- ${change.from}`));
        changes.push(theme.fg("success", `+ ${change.to}`));
      }
      addReviewSection(container, theme, "changes", changes.join("\n"));
    }

    if (review.note) addReviewSection(container, theme, "note", theme.fg("muted", review.note));

    if (review.vocabulary.length > 0) {
      const vocabulary = ["◆ vocabulary"];
      for (const item of review.vocabulary) {
        const gloss = item.gloss ? theme.fg("dim", `  ${item.gloss}`) : "";
        vocabulary.push(`${item.from} → ${item.to}${gloss}`);
      }
      addReviewSection(container, theme, "vocabulary", vocabulary.join("\n"));
    }

    if (expanded) {
      addReviewSection(container, theme, "note", theme.fg("dim", `model ${review.createdAt}`));
    }

    return container;
  });

  async function reviewPrompt(text: string, ctx: ExtensionContext): Promise<void> {
    const config = loadLinguaConfig(ctx.cwd);
    const eligibility = evaluateEligibility(text, config);

    if (!eligibility.eligible) {
      stats = { ...stats, skipped: stats.skipped + 1, lastSkipReason: eligibility.reason };
      return;
    }

    const target = resolveReviewerTarget(ctx, config, reviewerOverrides);
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
        (_tui, theme) => createReviewWidget(review, theme),
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
    getReviewerOverrides: () => reviewerOverrides,
    setReviewerOverrides: (overrides) => {
      reviewerOverrides = overrides;
    },
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
