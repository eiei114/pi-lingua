import type { LinguaConfig } from "../config.ts";
import type { PromptReview } from "../review.ts";
import { ankiSink } from "./anki.ts";
import { markdownLogSink } from "./markdown-log.ts";
import { describeError, failed, type ReviewSink, type SinkResult } from "./types.ts";

export const DEFAULT_SINKS: ReviewSink[] = [markdownLogSink, ankiSink];

/**
 * Runs every enabled sink matching the trigger, in order. Sinks run sequentially so two writers
 * never interleave on the same file, and one failing sink cannot stop the others.
 */
export async function runSinks(
  review: PromptReview,
  config: LinguaConfig,
  trigger: ReviewSink["trigger"],
  sinks: ReviewSink[] = DEFAULT_SINKS,
): Promise<SinkResult[]> {
  const results: SinkResult[] = [];
  for (const sink of sinks) {
    if (sink.trigger !== trigger) continue;
    if (!sink.isEnabled(config)) continue;
    try {
      results.push(await sink.write(review, config));
    } catch (error) {
      results.push(failed(sink.id, describeError(error)));
    }
  }
  return results;
}

export function formatSinkResults(results: SinkResult[]): string {
  if (results.length === 0) return "no sinks ran";
  return results
    .map((result) => {
      const target = result.path ? ` ${result.path}` : "";
      const detail = result.detail ? ` — ${result.detail}` : "";
      return `${result.sinkId}: ${result.status}${target}${detail}`;
    })
    .join("\n");
}
