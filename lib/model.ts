import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LinguaConfig } from "./config.ts";
import { extractAssistantText, type ReviewerPrompt } from "./review.ts";

export interface ReviewerTarget {
  model: Model<Api>;
  label: string;
  /** Where the model came from, so `/lingua:status` can explain the current behaviour. */
  source: "settings" | "session";
}

/**
 * Resolves the Reviewer Model. A configured provider/model wins; a bare model id is matched
 * against the available catalogue; otherwise the session model is used so the extension works
 * before any configuration exists.
 */
export function resolveReviewerTarget(
  ctx: ExtensionContext,
  config: LinguaConfig,
): ReviewerTarget | undefined {
  const { provider, model } = config.reviewer;

  if (provider && model) {
    const found = ctx.modelRegistry.find(provider, model);
    if (found) {
      return { model: found, label: `${found.provider}/${found.id}`, source: "settings" };
    }
  } else if (model) {
    const found = ctx.modelRegistry.getAvailable().find((candidate) => candidate.id === model);
    if (found) {
      return { model: found, label: `${found.provider}/${found.id}`, source: "settings" };
    }
  }

  if (ctx.model) {
    return {
      model: ctx.model,
      label: `${ctx.model.provider}/${ctx.model.id}`,
      source: "session",
    };
  }

  return undefined;
}

// Full rendering plus chunked text, IPA, and optional kana need more than a short review budget.
export const REVIEWER_MAX_TOKENS = 8192;

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
  const message = await ctx.modelRegistry.complete(
    target.model,
    {
      systemPrompt: prompt.systemPrompt,
      messages: [{ role: "user", content: prompt.userPrompt, timestamp: Date.now() }],
    },
    { maxTokens: REVIEWER_MAX_TOKENS },
  );

  const text = extractAssistantText(message);
  if (!text) {
    throw new Error(`reviewer model returned no text (stopReason: ${message.stopReason})`);
  }
  return text;
}
