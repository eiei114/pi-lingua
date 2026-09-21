import { appendFile, mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expandHome, type LinguaConfig } from "../config.ts";
import type { PromptReview } from "../review.ts";
import { describeError, failed, type ReviewSink, type SinkResult } from "./types.ts";

export const MARKDOWN_LOG_SINK_ID = "markdown-log";

/** Local calendar date, not UTC, so a review lands in the file the user is living in. */
export function localDateKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "unknown-date";
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localTimeLabel(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return "--:--";
  const hours = `${date.getHours()}`.padStart(2, "0");
  const minutes = `${date.getMinutes()}`.padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function reviewLogPath(config: LinguaConfig, review: PromptReview): string {
  return join(expandHome(config.sinks.reviewLog.dir), `${localDateKey(review.createdAt)}.md`);
}

export function renderReviewLogHeader(review: PromptReview): string {
  return `${[
    "---",
    `date: ${localDateKey(review.createdAt)}`,
    `target_language: ${review.targetLanguageName}`,
    `native_language: ${review.nativeLanguageName}`,
    "---",
  ].join("\n")}\n\n`;
}

/** One review as a self-contained markdown section, readable in any markdown viewer. */
export function renderReviewLogSection(review: PromptReview): string {
  const direction =
    review.language === "native"
      ? `${review.nativeLanguageName} → ${review.targetLanguageName}`
      : `${review.targetLanguageName} review`;

  const lines: string[] = [];
  lines.push(`## ${localTimeLabel(review.createdAt)} · ${direction}`);
  lines.push("");
  lines.push(`- **wrote:** ${review.prompt}`);
  lines.push(`- **${review.targetLanguageName}:** ${review.rendering}`);

  // A native-language review is a translation, so any `changes` the model volunteered would be a
  // restatement of the whole sentence rather than a correction. Only target-language reviews have
  // something to diff.
  if (review.language === "target" && review.changes.length > 0) {
    lines.push("- **changes:**");
    for (const change of review.changes) {
      lines.push(`  - \`${change.from}\` → \`${change.to}\``);
    }
  }

  if (review.note) lines.push(`- **note:** ${review.note}`);

  if (review.vocabulary.length > 0) {
    lines.push("- **vocabulary:**");
    for (const item of review.vocabulary) {
      const gloss = item.gloss ? ` (${item.gloss})` : "";
      lines.push(`  - ${item.from} → ${item.to}${gloss}`);
    }
  }

  // Two newlines: one closes the last line, the second separates this section from the next one.
  lines.push("", "");
  return lines.join("\n");
}

/**
 * True only when the log file already carries content. Checking size rather than existence means a
 * file left empty by an interrupted write still gets its frontmatter on the next attempt.
 */
async function hasContent(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.size > 0;
  } catch {
    return false;
  }
}

export const markdownLogSink: ReviewSink = {
  id: MARKDOWN_LOG_SINK_ID,
  trigger: "auto",

  isEnabled(config: LinguaConfig): boolean {
    return config.sinks.reviewLog.enabled;
  },

  async write(review: PromptReview, config: LinguaConfig): Promise<SinkResult> {
    const directory = expandHome(config.sinks.reviewLog.dir);
    const filePath = reviewLogPath(config, review);

    try {
      await mkdir(directory, { recursive: true });

      const sequence = renderReviewLogSection(review);

      if (await hasContent(filePath)) {
        await appendFile(filePath, sequence, "utf8");
      } else {
        // Create with the header first so the file always opens with valid frontmatter.
        await writeFile(filePath, renderReviewLogHeader(review) + sequence, "utf8");
      }

      return { sinkId: MARKDOWN_LOG_SINK_ID, status: "written", path: filePath };
    } catch (error) {
      return failed(MARKDOWN_LOG_SINK_ID, `${filePath}: ${describeError(error)}`);
    }
  },
};
