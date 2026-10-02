import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expandHome, type LinguaConfig } from "./config.ts";
import { resolveReviewerTarget } from "./model.ts";
import { formatReviewerEffort, pickReviewerEffort, pickReviewerModel } from "./reviewer-picker.ts";
import type { ReviewerOverrides } from "./reviewer-overrides.ts";
import type { PromptReview } from "./review.ts";
import {
  displaySettingsPath,
  hasProjectSettings,
  type LinguaSettingsChange,
  type SettingsWrite,
} from "./settings.ts";
import { formatSinkResults } from "./sinks/dispatch.ts";
import type { SinkResult } from "./sinks/types.ts";

export interface LinguaStats {
  reviewed: number;
  skipped: number;
  lastSkipReason: string | undefined;
  reviewerLabel: string | undefined;
  lastSinkResults: SinkResult[];
}

export interface LinguaCommandDeps {
  getConfig(ctx: ExtensionCommandContext): LinguaConfig;
  getReviewerOverrides(): ReviewerOverrides;
  setReviewerOverrides(overrides: ReviewerOverrides): void;
  isEnabled(ctx: ExtensionCommandContext): boolean;
  setEnabled(enabled: boolean): void;
  /** Writes values into Pi's settings files so the next session starts with them. */
  persistSettings(changes: readonly LinguaSettingsChange[], ctx: ExtensionCommandContext): SettingsWrite[];
  getLastReview(): PromptReview | undefined;
  clearWidget(ctx: ExtensionCommandContext): void;
  appendDetail(review: PromptReview): void;
  runManualSinks(review: PromptReview, ctx: ExtensionCommandContext): Promise<SinkResult[]>;
  getStats(): LinguaStats;
}

export const LINGUA_COMMANDS = [
  { name: "lingua:last", description: "Show the full text of the most recent Prompt Review" },
  { name: "lingua:card", description: "Send the most recent Vocabulary Suggestions to Anki" },
  { name: "lingua:off", description: "Stop reviewing prompts, clear the widget, and save it for new sessions" },
  { name: "lingua:on", description: "Resume reviewing prompts and save it for new sessions" },
  { name: "lingua:status", description: "Show review counts, sinks, and the Reviewer Model in use" },
  { name: "lingua:configure", description: "Show the settings block to paste into .pi/settings.json" },
  { name: "lingua:model", description: "Choose the Reviewer Model (Pi model selector)" },
  { name: "lingua:effort", description: "Choose reviewer thinking effort (Pi thinking selector)" },
] as const;

export interface SettingsWriteSummary {
  /** One clause describing where the values landed, or why nothing was written. */
  text: string;
  warning: boolean;
}

/**
 * Turns what the writer did into one clause for a notification. A shadowed write is the only
 * failure worth a warning: the value was saved, but a file that could not be edited still wins.
 */
export function summarizeSettingsWrite(writes: readonly SettingsWrite[], cwd: string): SettingsWriteSummary {
  if (writes.length === 0) {
    return { text: "no settings change was needed", warning: false };
  }

  const saved = writes.map((write) => displaySettingsPath(write.scope, cwd)).join(" and ");
  const shadowed = writes.filter((write) => write.shadowed);
  if (shadowed.length === 0) {
    return { text: `saved to ${saved}`, warning: false };
  }

  const shadowing = displaySettingsPath("project", cwd);
  return {
    text: `saved to ${saved}, but ${shadowing} still sets the same keys and this project is not trusted`,
    warning: true,
  };
}

export function formatConfigJson(config: LinguaConfig): string {
  return JSON.stringify({ "pi-lingua": config }, null, 2);
}

export interface StatusInput {
  config: LinguaConfig;
  stats: LinguaStats;
  enabled: boolean;
  reviewerEffort?: string;
  /** The file new keys are written to, e.g. `~/.pi/agent/settings.json`. */
  settingsFile?: string;
  /** True when the project has a settings file that Pi is not reading because it is untrusted. */
  projectSettingsIgnored?: boolean;
}

export function formatStatus(input: StatusInput): string {
  const { config, stats, enabled } = input;
  const lines: string[] = [];
  lines.push(`pi-lingua: ${enabled ? "on" : "off"}`);
  lines.push(
    `reviewer: ${stats.reviewerLabel ?? "(unresolved)"}${stats.reviewerLabel ? "" : " — check settings.reviewer"}`,
  );
  lines.push(`reviewer effort: ${input.reviewerEffort ?? "off"}`);
  lines.push(
    `languages: ${config.targetLanguage} (target) / ${config.nativeLanguage} (native) · explain in ${config.explainIn}`,
  );
  lines.push(`minimum length: ${config.minWords} words / ${config.minChars} characters`);

  const skip = stats.lastSkipReason ? ` (last skip: ${stats.lastSkipReason})` : "";
  lines.push(`reviewed ${stats.reviewed}, skipped ${stats.skipped}${skip}`);

  const ignored = input.projectSettingsIgnored ? " · this project's settings are not trusted" : "";
  lines.push(`settings file: ${input.settingsFile ?? "(global)"}${ignored}`);

  const log = config.sinks.reviewLog;
  lines.push(
    `sink markdown-log: ${log.enabled ? "enabled" : "disabled"} → ${expandHome(log.dir)}`,
  );
  const anki = config.sinks.anki;
  lines.push(
    `sink anki: ${anki.enabled ? "enabled" : "disabled"} (${anki.mode}, deck ${anki.deck})`,
  );

  if (stats.lastSinkResults.length > 0) {
    lines.push("last sinks:");
    for (const line of formatSinkResults(stats.lastSinkResults).split("\n")) {
      lines.push(`  ${line}`);
    }
  }

  return lines.join("\n");
}

/**
 * Registers the human-facing surface. Every command takes no inline arguments: anything the
 * command needs is either already in state or reported directly, so nothing has to be
 * remembered as a positional argument at the prompt.
 */
export function registerLinguaCommands(pi: ExtensionAPI, deps: LinguaCommandDeps): void {
  function settingsNote(changes: readonly LinguaSettingsChange[], ctx: ExtensionCommandContext): SettingsWriteSummary {
    try {
      return summarizeSettingsWrite(deps.persistSettings(changes, ctx), ctx.cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { text: `the settings file could not be written (${detail})`, warning: true };
    }
  }

  pi.registerCommand("lingua:last", {
    description: LINGUA_COMMANDS[0].description,
    handler: async (_args, ctx) => {
      const review = deps.getLastReview();
      if (!review) {
        ctx.ui.notify("No Prompt Review in this session yet.", "info");
        return;
      }
      deps.appendDetail(review);
    },
  });

  pi.registerCommand("lingua:card", {
    description: LINGUA_COMMANDS[1].description,
    handler: async (_args, ctx) => {
      const review = deps.getLastReview();
      if (!review) {
        ctx.ui.notify("No Prompt Review in this session yet.", "info");
        return;
      }
      const results = await deps.runManualSinks(review, ctx);
      if (results.length === 0) {
        ctx.ui.notify(
          "The Anki sink is disabled. Set pi-lingua.sinks.anki.enabled to true in .pi/settings.json.",
          "warning",
        );
        return;
      }
      const failedAny = results.some((result) => result.status === "failed");
      const skippedAny = results.some((result) => result.status === "skipped");
      const type = failedAny ? "error" : skippedAny ? "warning" : "info";
      ctx.ui.notify(formatSinkResults(results), type);
    },
  });

  pi.registerCommand("lingua:off", {
    description: LINGUA_COMMANDS[2].description,
    handler: async (_args, ctx) => {
      deps.setEnabled(false);
      deps.clearWidget(ctx);
      const saved = settingsNote([{ keyPath: "enabled", value: false }], ctx);
      ctx.ui.notify(
        `pi-lingua review is off, in this session and in new sessions (${saved.text}).`,
        saved.warning ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("lingua:on", {
    description: LINGUA_COMMANDS[3].description,
    handler: async (_args, ctx) => {
      deps.setEnabled(true);
      // Every file that says `false` is cleared, so no lower-precedence file can keep it off.
      const saved = settingsNote([{ keyPath: "enabled", value: true, targets: "all" }], ctx);
      ctx.ui.notify(
        `pi-lingua review is on, in this session and in new sessions (${saved.text}).`,
        saved.warning ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("lingua:status", {
    description: LINGUA_COMMANDS[4].description,
    handler: async (_args, ctx) => {
      const config = deps.getConfig(ctx);
      const target = resolveReviewerTarget(ctx, config, deps.getReviewerOverrides());
      ctx.ui.notify(
        formatStatus({
          config,
          stats: deps.getStats(),
          enabled: deps.isEnabled(ctx),
          reviewerEffort: formatReviewerEffort(target?.thinkingLevel),
          settingsFile: displaySettingsPath("global", ctx.cwd),
          projectSettingsIgnored: !ctx.isProjectTrusted() && hasProjectSettings(ctx.cwd),
        }),
        "info",
      );
    },
  });

  pi.registerCommand("lingua:configure", {
    description: LINGUA_COMMANDS[5].description,
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          "Paste this block into .pi/settings.json (project) or the agent settings file (global).",
          `Project settings: ${ctx.cwd}/.pi/settings.json`,
          "",
          formatConfigJson(deps.getConfig(ctx)),
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("lingua:model", {
    description: LINGUA_COMMANDS[6].description,
    handler: async (_args, ctx) => {
      const config = deps.getConfig(ctx);
      const currentOverrides = deps.getReviewerOverrides();
      const target = resolveReviewerTarget(ctx, config, currentOverrides);
      const next = await pickReviewerModel(ctx, currentOverrides, target);
      if (!next) return;
      deps.setReviewerOverrides(next);

      // A session-model choice is represented by having no reviewer route in settings at all.
      const saved = next.useSessionModel
        ? settingsNote(
            [
              { keyPath: "reviewer.provider", value: undefined, targets: "all" },
              { keyPath: "reviewer.model", value: undefined, targets: "all" },
            ],
            ctx,
          )
        : settingsNote(
            [
              { keyPath: "reviewer.provider", value: next.provider },
              { keyPath: "reviewer.model", value: next.model },
            ],
            ctx,
          );

      const resolved = resolveReviewerTarget(ctx, config, next);
      const label = resolved ? `${resolved.label} (${resolved.source})` : "nothing available for this session";
      ctx.ui.notify(
        `Reviewer model: ${label} — ${saved.text}.`,
        resolved && !saved.warning ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("lingua:effort", {
    description: LINGUA_COMMANDS[7].description,
    handler: async (_args, ctx) => {
      const config = deps.getConfig(ctx);
      const currentOverrides = deps.getReviewerOverrides();
      const target = resolveReviewerTarget(ctx, config, currentOverrides);
      const next = await pickReviewerEffort(ctx, currentOverrides, target);
      if (!next) return;
      deps.setReviewerOverrides(next);

      // `off` is the absence of a thinking level, so it removes the key instead of storing "off".
      const saved = settingsNote(
        [
          {
            keyPath: "reviewer.thinkingLevel",
            value: next.thinkingLevel === "off" ? undefined : next.thinkingLevel,
            targets: next.thinkingLevel === "off" ? "all" : "owner",
          },
        ],
        ctx,
      );

      const resolved = resolveReviewerTarget(ctx, config, next);
      ctx.ui.notify(
        `Reviewer effort: ${formatReviewerEffort(resolved?.thinkingLevel)} (task-run thinking unchanged) — ${saved.text}.`,
        saved.warning ? "warning" : "info",
      );
    },
  });
}
