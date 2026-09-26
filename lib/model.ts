import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelThinkingLevel,
  ModelsSimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LinguaConfig } from "./config.ts";
import type { ReviewerOverrides } from "./reviewer-overrides.ts";
import { extractAssistantText, type ReviewerPrompt } from "./review.ts";

export interface ReviewerTarget {
  model: Model<Api>;
  label: string;
  /** Where the model came from, so `/lingua:status` can explain the current behaviour. */
  source: "settings" | "session" | "override";
  thinkingLevel?: ModelThinkingLevel;
}

function resolveThinkingLevel(
  config: LinguaConfig,
  overrides: ReviewerOverrides | undefined,
): ModelThinkingLevel | undefined {
  if (overrides?.thinkingLevel !== undefined) return overrides.thinkingLevel;
  const fromSettings = config.reviewer.thinkingLevel?.trim();
  return fromSettings ? (fromSettings as ModelThinkingLevel) : undefined;
}

/**
 * Resolves the Reviewer Model. Session overrides win, then configured provider/model, then the
 * session model so the extension works before any configuration exists.
 */
export function resolveReviewerTarget(
  ctx: ExtensionContext,
  config: LinguaConfig,
  overrides?: ReviewerOverrides,
): ReviewerTarget | undefined {
  const thinkingLevel = resolveThinkingLevel(config, overrides);

  if (overrides?.useSessionModel && ctx.model) {
    return {
      model: ctx.model,
      label: `${ctx.model.provider}/${ctx.model.id}`,
      source: "override",
      thinkingLevel,
    };
  }

  const provider = overrides?.provider ?? config.reviewer.provider;
  const modelId = overrides?.model ?? config.reviewer.model;
  const fromOverride = Boolean(overrides?.provider && overrides?.model);

  if (provider && modelId) {
    const found = ctx.modelRegistry.find(provider, modelId);
    if (found) {
      return {
        model: found,
        label: `${found.provider}/${found.id}`,
        source: fromOverride ? "override" : "settings",
        thinkingLevel,
      };
    }
  } else if (modelId) {
    const found = ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === modelId);
    if (found) {
      return {
        model: found,
        label: `${found.provider}/${found.id}`,
        source: fromOverride ? "override" : "settings",
        thinkingLevel,
      };
    }
  }

  if (ctx.model) {
    return {
      model: ctx.model,
      label: `${ctx.model.provider}/${ctx.model.id}`,
      source: "session",
      thinkingLevel,
    };
  }

  return undefined;
}

// Full rendering plus chunked text, IPA, and optional kana need more than a short review budget.
export const REVIEWER_MAX_TOKENS = 8192;

type StreamableModelRegistry = ExtensionContext["modelRegistry"] & {
  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream;
};

function reasoningForCompletion(
  model: Model<Api>,
  level: ModelThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (!level || level === "off") return undefined;
  const clamped = clampThinkingLevel(model, level);
  if (clamped === "off") return undefined;
  return clamped;
}

/**
 * The one place this package touches a model. It stays deliberately small: a single in-process
 * call through the registry, which reuses Pi's resolved provider auth. No child process is
 * spawned here (see ADR-0002).
 */
export async function requestReviewerCompletion(
  ctx: ExtensionContext,
  target: ReviewerTarget,
  prompt: ReviewerPrompt,
): Promise<string> {
  const context = {
    systemPrompt: prompt.systemPrompt,
    messages: [{ role: "user" as const, content: prompt.userPrompt, timestamp: Date.now() }],
  };

  const reasoning = reasoningForCompletion(target.model, target.thinkingLevel);
  const registry = ctx.modelRegistry as StreamableModelRegistry;
  const message = reasoning
    ? await registry
        .streamSimple(target.model, context, {
          maxTokens: REVIEWER_MAX_TOKENS,
          reasoning,
        })
        .result()
    : await registry.complete(target.model, context, { maxTokens: REVIEWER_MAX_TOKENS });

  const text = extractAssistantText(message);
  if (!text) {
    throw new Error(`reviewer model returned no text (stopReason: ${message.stopReason})`);
  }
  return text;
}
