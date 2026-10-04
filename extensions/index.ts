import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { watchFile, unwatchFile } from "node:fs";
import { registerLinguaCommands, type LinguaStats } from "../lib/commands.ts";
import { loadLinguaConfig } from "../lib/config.ts";
import { settingsFilePath, writeLinguaSettings, type LinguaSettingsChange } from "../lib/settings.ts";
import { evaluateEligibility } from "../lib/eligibility.ts";
import { requestReviewerCompletion, resolveReviewerTarget } from "../lib/model.ts";
import {
  renderReviewWidgetSections,
  renderSpeakingGuide,
} from "../lib/render.ts";
import { buildReviewerPrompt, parseReviewResponse, type PromptReview } from "../lib/review.ts";
import { runSinks } from "../lib/sinks/dispatch.ts";
import { describeError, type SinkResult } from "../lib/sinks/types.ts";

export const REVIEW_WIDGET_KEY = "pi-lingua:review";
export const REVIEW_ENTRY_TYPE = "pi-lingua-review";

function createReviewLayout(theme: Theme) {
  const container = new Container();
  let sectionIndex = 0;
  return {
    container,
    addSection(content: string): void {
      // Semantic tool colors are often nearly identical (or imply error/success). Alternate
      // two neutral theme surfaces and leave an unfilled row so adjacent blocks never merge.
      if (sectionIndex > 0) container.addChild(new Spacer(1));
      const background = sectionIndex++ % 2 === 0 ? "selectedBg" : "customMessageBg";
      const box = new Box(1, 0, (text) => theme.bg(background, text));
      box.addChild(new Text(content, 0, 0));
      container.addChild(box);
    },
  };
}

function createReviewWidget(review: PromptReview, theme: Theme): Container {
  const layout = createReviewLayout(theme);
  for (const section of renderReviewWidgetSections(review)) {
    // The vocabulary preview already has a blank line for plain-text callers; the layout
    // supplies its own unfilled gap instead of coloring that line inside the block.
    const lines = section.kind === "vocabulary" ? section.lines.slice(1) : section.lines;
    layout.addSection(lines.join("\n"));
  }
  return layout.container;
}

export default function (pi: ExtensionAPI) {
  let revision = 0;
  let stopWatching: (() => void) | undefined;
  const pending = new Set<AbortController>();

  function invalidateReviews(): void {
    revision += 1;
    for (const controller of pending) controller.abort();
  }
  let lastReview: PromptReview | undefined;
  let stats: LinguaStats = {
    reviewed: 0,
    skipped: 0,
    lastSkipReason: undefined,
    reviewerLabel: undefined,
    lastSinkResults: [],
  };

  function configFor(ctx: ExtensionContext) {
    // Never let project blocks or session-local overrides shadow shared preferences.
    return loadLinguaConfig(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
  }

  function isEnabled(ctx: ExtensionContext): boolean {
    return configFor(ctx).enabled;
  }

  pi.on("session_start", async (_event, ctx) => {
    stopWatching?.();
    invalidateReviews();
    const path = settingsFilePath("global", ctx.cwd);
    let snapshot = JSON.stringify(configFor(ctx));
    const changed = () => {
      const next = JSON.stringify(configFor(ctx));
      if (next === snapshot) return;
      snapshot = next;
      invalidateReviews();
      lastReview = undefined;
      if (ctx.hasUI) ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    };
    // Polling works across process boundaries and atomic file replacements on Windows.
    watchFile(path, { interval: 250, persistent: false }, changed);
    stopWatching = () => unwatchFile(path, changed);
  });

  pi.on("session_shutdown", async () => {
    stopWatching?.();
    stopWatching = undefined;
    invalidateReviews();
  });

  function persistSettings(
    changes: readonly LinguaSettingsChange[],
    ctx: ExtensionCommandContext,
  ) {
    const writes = writeLinguaSettings(changes, {
      cwd: ctx.cwd,
      projectWritesAllowed: ctx.isProjectTrusted(),
    });
    invalidateReviews();
    lastReview = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    return writes;
  }

  pi.registerEntryRenderer<PromptReview>(REVIEW_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const review = entry.data;
    const layout = createReviewLayout(theme);

    if (!review) {
      layout.addSection(theme.fg("dim", "pi-lingua review (no data)"));
      return layout.container;
    }

    const header =
      review.language === "native"
        ? `${review.nativeLanguageName} → ${review.targetLanguageName}`
        : `${review.targetLanguageName} review`;
    layout.addSection(
      `${theme.bold(`pi-lingua · ${header}`)}\n${theme.fg("dim", "wrote")} ${review.prompt}`,
    );
    layout.addSection(
      `${theme.fg("accent", review.targetLanguageName)} ${review.rendering}`,
    );

    const speaking = renderSpeakingGuide(review);
    if (speaking.length > 0) layout.addSection(speaking.join("\n"));

    if (review.changes.length > 0) {
      const changes: string[] = [];
      for (const change of review.changes) {
        changes.push(theme.fg("error", `- ${change.from}`));
        changes.push(theme.fg("success", `+ ${change.to}`));
      }
      layout.addSection(changes.join("\n"));
    }

    if (review.note) layout.addSection(theme.fg("muted", review.note));

    if (review.vocabulary.length > 0) {
      const vocabulary = ["◆ vocabulary"];
      for (const item of review.vocabulary) {
        const gloss = item.gloss ? theme.fg("dim", `  ${item.gloss}`) : "";
        vocabulary.push(`${item.from} → ${item.to}${gloss}`);
      }
      layout.addSection(vocabulary.join("\n"));
    }

    if (expanded) {
      layout.addSection(theme.fg("dim", `model ${review.createdAt}`));
    }

    return layout.container;
  });

  async function reviewPrompt(text: string, ctx: ExtensionContext): Promise<void> {
    const config = configFor(ctx);
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
    const startedAtRevision = revision;
    const snapshot = JSON.stringify(config);
    const controller = new AbortController();
    pending.add(controller);

    let raw: string;
    try {
      raw = await requestReviewerCompletion(ctx, target, prompt, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) return;
      stats = { ...stats, skipped: stats.skipped + 1, lastSkipReason: "reviewer call failed" };
      if (ctx.hasUI) {
        ctx.ui.notify(`pi-lingua review failed: ${describeError(error)}`, "warning");
      }
      return;
    } finally {
      pending.delete(controller);
    }

    // Re-check even before the watcher fires; stale work must never restore an OFF widget.
    if (
      controller.signal.aborted ||
      startedAtRevision !== revision ||
      snapshot !== JSON.stringify(configFor(ctx))
    ) return;

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
    if (!isEnabled(ctx)) return { action: "continue" };
    if (event.source === "extension") return { action: "continue" };

    // Deliberately not awaited. The review is a side lane; the prompt goes to the agent now.
    void reviewPrompt(event.text, ctx).catch(() => {
      // reviewPrompt already reports its own failures; this only stops an unhandled rejection.
    });

    return { action: "continue" };
  });

  registerLinguaCommands(pi, {
    getConfig: (ctx) => configFor(ctx),
    isEnabled: (ctx) => isEnabled(ctx),
    persistSettings,
    getLastReview: () => lastReview,
    clearWidget: (ctx) => {
      if (ctx.hasUI) ctx.ui.setWidget(REVIEW_WIDGET_KEY, undefined);
    },
    appendDetail: (review) => {
      pi.appendEntry(REVIEW_ENTRY_TYPE, review);
    },
    runManualSinks: (review, ctx) => runSinks(review, configFor(ctx), "manual"),
    getStats: () => stats,
  });
}
