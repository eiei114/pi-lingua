import type { LinguaConfig } from "../config.ts";
import type { PromptReview } from "../review.ts";

export type SinkStatus = "written" | "skipped" | "failed";

export interface SinkResult {
  sinkId: string;
  status: SinkStatus;
  path?: string;
  detail?: string;
}

/**
 * A Sink decides where a Prompt Review ends up.
 *
 * `trigger` separates the two kinds of destination. "auto" sinks run for every eligible review
 * without asking; "manual" sinks only run when the user invokes them, so an external system such
 * as Anki never accumulates cards the user did not choose.
 */
export interface ReviewSink {
  readonly id: string;
  readonly trigger: "auto" | "manual";
  isEnabled(config: LinguaConfig): boolean;
  write(review: PromptReview, config: LinguaConfig): Promise<SinkResult>;
}

export function skipped(sinkId: string, detail: string): SinkResult {
  return { sinkId, status: "skipped", detail };
}

export function failed(sinkId: string, detail: string): SinkResult {
  return { sinkId, status: "failed", detail };
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
