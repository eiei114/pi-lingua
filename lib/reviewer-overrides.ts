import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

/** Session-only reviewer routing; settings.json still wins until the user overrides here. */
export interface ReviewerOverrides {
  /** When true, ignore settings reviewer and use the session model. */
  useSessionModel?: boolean;
  provider?: string;
  model?: string;
  thinkingLevel?: ModelThinkingLevel;
}

export function createEmptyReviewerOverrides(): ReviewerOverrides {
  return {};
}
