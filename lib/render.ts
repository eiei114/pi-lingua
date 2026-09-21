import type { ExplainLanguage } from "./config.ts";
import type { PromptReview } from "./review.ts";

export const DEFAULT_WIDGET_WIDTH = 72;

export interface RenderReviewOptions {
  explainIn: ExplainLanguage;
  width?: number;
}

function truncate(text: string, width: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= width) return single;
  return `${single.slice(0, Math.max(0, width - 1))}…`;
}

/** Truncates so the prefix plus content still fits inside the widget width. */
function lineWith(prefix: string, text: string, width: number): string {
  return prefix + truncate(text, Math.max(1, width - prefix.length));
}

/**
 * The always-visible tier. Kept at or below eight lines because it renders directly above the
 * prompt editor; anything longer belongs in the transcript view (`/lingua:last`).
 */
export function renderReviewWidget(review: PromptReview, options: RenderReviewOptions): string[] {
  const width = options.width ?? DEFAULT_WIDGET_WIDTH;
  const targetTag = review.targetLanguageTag.toUpperCase();
  const lines: string[] = [];

  if (review.language === "native") {
    const nativeTag = review.nativeLanguageName.slice(0, 2).toUpperCase();
    lines.push(`${nativeTag} → ${targetTag}`);
    lines.push(lineWith("> ", review.prompt, width));
    lines.push(lineWith("+ ", review.rendering, width));
  } else {
    lines.push(`${targetTag} review`);
    if (review.changes.length > 0) {
      for (const change of review.changes) {
        lines.push(lineWith("- ", change.from, width));
        lines.push(lineWith("+ ", change.to, width));
      }
    } else {
      lines.push(lineWith("ok  ", review.rendering, width));
    }
  }

  if (review.note) lines.push(truncate(review.note, width));

  if (review.vocabulary.length > 0) {
    lines.push("");
    lines.push("◆ vocab");
    for (const item of review.vocabulary) {
      const gloss = item.gloss ? `  ${truncate(item.gloss, 30)}` : "";
      lines.push(
        `  ${truncate(item.from, 24)} → ${truncate(item.to, 24)}${gloss}`,
      );
    }
  }

  return lines;
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
