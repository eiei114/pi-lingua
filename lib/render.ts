import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExplainLanguage } from "./config.ts";
import type { PromptReview } from "./review.ts";

export const DEFAULT_WIDGET_WIDTH = 72;

export interface RenderReviewOptions {
  explainIn: ExplainLanguage;
  width?: number;
}

/** Full review content, word-wrapped to terminal cell width without ellipses. */
export function renderReviewWidget(review: PromptReview, options: RenderReviewOptions): string[] {
  const width = options.width ?? DEFAULT_WIDGET_WIDTH;
  const targetTag = review.targetLanguageTag.toUpperCase();
  const lines: string[] = [];

  if (review.language === "native") {
    const nativeTag = review.nativeLanguageName.slice(0, 2).toUpperCase();
    lines.push(`${nativeTag} → ${targetTag}`);
    lines.push(`> ${review.prompt}`);
    lines.push(`+ ${review.rendering}`);
  } else {
    lines.push(`${targetTag} review`);
    if (review.changes.length > 0) {
      for (const change of review.changes) {
        lines.push(`- ${change.from}`);
        lines.push(`+ ${change.to}`);
      }
    } else {
      lines.push(`ok  ${review.rendering}`);
    }
  }

  if (review.note) lines.push(review.note);

  if (review.vocabulary.length > 0) {
    lines.push("");
    lines.push("◆ vocab");
    for (const item of review.vocabulary) {
      const gloss = item.gloss ? `  ${item.gloss}` : "";
      lines.push(
        `  ${item.from} → ${item.to}${gloss}`,
      );
    }
  }

  return lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

/** The on-demand tier, used when the user asks for the full review. */
export function renderReviewDetail(review: PromptReview): string {
  const lines: string[] = [];
  const direction =
    review.language === "native"
      ? `${review.nativeLanguageName} → ${review.targetLanguageName}`
      : `${review.targetLanguageName} review`;

  lines.push(`## ${direction}`);
  lines.push("");
  lines.push(`** wrote:** ${review.prompt}`);
  lines.push(`**${review.targetLanguageName}:** ${review.rendering}`);

  if (review.changes.length > 0) {
    lines.push("");
    lines.push("**changes**");
    for (const change of review.changes) {
      lines.push(`- ${change.from}`);
      lines.push(`+ ${change.to}`);
    }
  }

  if (review.note) {
    lines.push("");
    lines.push(review.note);
  }

  if (review.vocabulary.length > 0) {
    lines.push("");
    lines.push("**vocabulary**");
    for (const item of review.vocabulary) {
      lines.push(`- ${item.from} → ${item.to}${item.gloss ? ` (${item.gloss})` : ""}`);
    }
  }

  return lines.join("\n");
}
