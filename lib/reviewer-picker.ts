import type { Model, ModelThinkingLevel, ThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  ModelSelectorComponent,
  ThinkingSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ReviewerOverrides } from "./reviewer-overrides.ts";
import type { ReviewerTarget } from "./model.ts";

const SESSION_MODEL_LABEL = "Session model (same as task run)";

function modelRegistryRuntime(ctx: ExtensionCommandContext): ModelRuntime {
  return (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
}

function candidateModels(ctx: ExtensionCommandContext): Model<import("@earendil-works/pi-ai").Api>[] {
  if (ctx.scopedModels.length > 0) {
    return ctx.scopedModels.map((entry) => entry.model);
  }
  return ctx.modelRegistry.getAvailable().filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
}

function currentReviewerModel(
  ctx: ExtensionCommandContext,
  overrides: ReviewerOverrides,
  target: ReviewerTarget | undefined,
): Model<import("@earendil-works/pi-ai").Api> | undefined {
  if (overrides.provider && overrides.model) {
    return ctx.modelRegistry.find(overrides.provider, overrides.model);
  }
  if (overrides.useSessionModel) return ctx.model;
  if (target?.source === "settings") {
    return ctx.modelRegistry.find(
      target.model.provider,
      target.model.id,
    );
  }
  return target?.model ?? ctx.model;
}

function asThinkingLevels(levels: ModelThinkingLevel[]): ThinkingLevel[] {
  return levels.filter((level): level is ThinkingLevel => level !== "off");
}

const CATALOG_LABEL = "Choose from model catalog…";

/** Pi /model-style searchable selector for the Reviewer Model. */
export async function pickReviewerModel(
  ctx: ExtensionCommandContext,
  overrides: ReviewerOverrides,
  target: ReviewerTarget | undefined,
): Promise<ReviewerOverrides | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Reviewer model selection needs the Pi TUI.", "warning");
    return undefined;
  }

  const route = await ctx.ui.select("Reviewer model", [SESSION_MODEL_LABEL, CATALOG_LABEL]);
  if (!route) return undefined;
  if (route === SESSION_MODEL_LABEL) {
    return { ...overrides, useSessionModel: true, provider: undefined, model: undefined };
  }

  const current = currentReviewerModel(ctx, overrides, target);
  const runtime = modelRegistryRuntime(ctx);
  const scopedModels =
    ctx.scopedModels.length > 0
      ? ctx.scopedModels
      : candidateModels(ctx).map((model) => ({ model }));

  const picked = await ctx.ui.custom<Model<import("@earendil-works/pi-ai").Api> | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ModelSelectorComponent(
        tui,
        current,
        runtime,
        scopedModels,
        (model) => done(model),
        () => done(undefined),
        undefined,
        undefined,
        undefined,
      );
      return selector;
    },
    { overlay: true },
  );

  if (picked === undefined) return undefined;

  return {
    ...overrides,
    useSessionModel: false,
    provider: picked.provider,
    model: picked.id,
  };
}

/** Pi thinking selector for reviewer effort (does not change session thinking). */
export async function pickReviewerEffort(
  ctx: ExtensionCommandContext,
  overrides: ReviewerOverrides,
  target: ReviewerTarget | undefined,
): Promise<ReviewerOverrides | undefined> {
  if (!ctx.hasUI || ctx.mode !== "tui") {
    ctx.ui.notify("Reviewer effort selection needs the Pi TUI.", "warning");
    return undefined;
  }

  const model = currentReviewerModel(ctx, overrides, target);
  if (!model) {
    ctx.ui.notify("No Reviewer Model resolved. Run /lingua:model first or set pi-lingua.reviewer.", "warning");
    return undefined;
  }

  const available = getSupportedThinkingLevels(model);
  const thinkingLevels = asThinkingLevels(available);
  if (thinkingLevels.length === 0 && !available.includes("off")) {
    ctx.ui.notify(`Model ${model.provider}/${model.id} does not expose thinking levels.`, "info");
    return undefined;
  }

  const currentLevel =
    overrides.thinkingLevel && overrides.thinkingLevel !== "off"
      ? (overrides.thinkingLevel as ThinkingLevel)
      : ("off" as ThinkingLevel);

  const levelsForUi: ThinkingLevel[] = available.includes("off")
    ? (["off", ...thinkingLevels] as ThinkingLevel[])
    : thinkingLevels;

  const picked = await ctx.ui.custom<ModelThinkingLevel | undefined>((_tui, _theme, _keybindings, done) => {
    const selector = new ThinkingSelectorComponent(
      currentLevel,
      levelsForUi,
      (level) => done(level as ModelThinkingLevel),
      () => done(undefined),
    );
    return selector;
  }, { overlay: true });

  if (picked === undefined) return undefined;
  return { ...overrides, thinkingLevel: picked };
}

export function formatReviewerEffort(level: ModelThinkingLevel | undefined): string {
  return level ?? "off";
}

export { SESSION_MODEL_LABEL };
