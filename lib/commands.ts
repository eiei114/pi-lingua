import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { expandHome, type LinguaConfig } from "./config.ts";
import type { PromptReview } from "./review.ts";
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
  isEnabled(): boolean;
  setEnabled(enabled: boolean): void;
  getLastReview(): PromptReview | undefined;
  clearWidget(ctx: ExtensionCommandContext): void;
  appendDetail(review: PromptReview): void;
  runManualSinks(review: PromptReview, ctx: ExtensionCommandContext): Promise<SinkResult[]>;
  getStats(): LinguaStats;
}

export const LINGUA_COMMANDS = [
  { name: "lingua:last", description: "Show the full text of the most recent Prompt Review" },
  { name: "lingua:card", description: "Send the most recent Vocabulary Suggestions to Anki" },
  { name: "lingua:off", description: "Stop reviewing prompts and clear the review widget" },
  { name: "lingua:on", description: "Resume reviewing prompts" },
  { name: "lingua:status", description: "Show review counts, sinks, and the Reviewer Model in use" },
  { name: "lingua:configure", description: "Show the settings block to paste into .pi/settings.json" },
] as const;

export function formatConfigJson(config: LinguaConfig): string {
  return JSON.stringify({ "pi-lingua": config }, null, 2);
}

export function formatStatus(config: LinguaConfig, stats: LinguaStats, enabled: boolean): string {
  const lines: string[] = [];
  lines.push(`pi-lingua: ${enabled ? "on" : "off"}`);
  lines.push(
    `reviewer: ${stats.reviewerLabel ?? "(unresolved)"}${stats.reviewerLabel ? "" : " — check settings.reviewer"}`,
  );
  lines.push(
    `languages: ${config.targetLanguage} (target) / ${config.nativeLanguage} (native) · explain in ${config.explainIn}`,
  );
  lines.push(`minimum length: ${config.minWords} words / ${config.minChars} characters`);

  const skip = stats.lastSkipReason ? ` (last skip: ${stats.lastSkipReason})` : "";
  lines.push(`reviewed ${stats.reviewed}, skipped ${stats.skipped}${skip}`);

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
      ctx.ui.notify("pi-lingua review is off. Prompt Review is not running.", "info");
    },
  });

  pi.registerCommand("lingua:on", {
    description: LINGUA_COMMANDS[3].description,
    handler: async (_args, ctx) => {
      deps.setEnabled(true);
      ctx.ui.notify("pi-lingua review is on.", "info");
    },
  });

  pi.registerCommand("lingua:status", {
    description: LINGUA_COMMANDS[4].description,
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        formatStatus(deps.getConfig(ctx), deps.getStats(), deps.isEnabled()),
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
}
