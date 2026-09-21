import type { LinguaConfig } from "./config.ts";
import { dominantScript, resolveLanguage, scriptedCharacterCount } from "./languages.ts";

export type PromptLanguage = "target" | "native" | "unknown";

export type EligibilitySkipReason =
  | "empty"
  | "command"
  | "unknown-language"
  | "code"
  | "too-short"
  | "native-prompts-disabled";

/**
 * Discriminated so callers that only handle eligible prompts get a narrowed language instead of
 * having to re-check for "unknown".
 */
export type EligibilityResult =
  | { eligible: true; language: "target" | "native"; reason: "eligible"; detail: string }
  | { eligible: false; language: PromptLanguage; reason: EligibilitySkipReason; detail: string };

const FENCED_BLOCK = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S+/gi;
const WORD_LIKE = /[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu;

/** Removes the parts of a prompt that are code or references rather than prose. */
export function stripNonProse(text: string): string {
  return text
    .replace(FENCED_BLOCK, " ")
    .replace(INLINE_CODE, " ")
    .replace(URL_LIKE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildProseText(text: string): string {
  const withoutBlocks = text.replace(FENCED_BLOCK, "");
  return stripNonProse(withoutBlocks);
}

export interface ProseLength {
  /** Whitespace-delimited tokens, meaningful for space-delimited languages. */
  words: number;
  /** Characters belonging to a known script, meaningful for CJK and Thai. */
  characters: number;
}

export function measureProse(text: string): ProseLength {
  return {
    words: text.match(WORD_LIKE)?.length ?? 0,
    characters: scriptedCharacterCount(text),
  };
}

/**
 * Decides locally whether a prompt is worth a Prompt Review. This runs before any model call, so
 * it must be cheap and must never throw; the reason string is surfaced through `/lingua:status`
 * and debug output so a skipped prompt is explainable rather than mysterious.
 */
export function evaluateEligibility(text: string, config: LinguaConfig): EligibilityResult {
  const raw = text.trim();
  if (!raw) {
    return { eligible: false, language: "unknown", reason: "empty", detail: "empty input" } as const;
  }

  if (raw.startsWith("/")) {
    return { eligible: false, language: "unknown", reason: "command", detail: "slash command" } as const;
  }

  const target = resolveLanguage(config.targetLanguage);
  const native = resolveLanguage(config.nativeLanguage);
  if (!target || !native) {
    const missing = !target ? config.targetLanguage : config.nativeLanguage;
    return {
      eligible: false,
      language: "unknown",
      reason: "unknown-language",
      detail: `unrecognized language setting: ${missing}`,
    };
  }

  const prose = buildProseText(raw);
  if (!prose) {
    return { eligible: false, language: "unknown", reason: "code", detail: "no prose left after removing code" };
  }

  const script = dominantScript(prose);
  if (!script) {
    return { eligible: false, language: "unknown", reason: "code", detail: "no letters in prose" };
  }

  let language: "target" | "native" | "unknown" = "unknown";
  if (target.definition.scripts.includes(script)) {
    language = "target";
  } else if (native.definition.scripts.includes(script)) {
    language = "native";
  }

  if (language === "unknown") {
    return {
      eligible: false,
      language,
      reason: "unknown-language",
      detail: `dominant script "${script}" is neither ${target.definition.name} nor ${native.definition.name}`,
    };
  }

  const length = measureProse(prose);
  const spaceDelimited = (language === "target" ? target : native).definition.spaceDelimited;
  if (spaceDelimited) {
    if (length.words < config.minWords) {
      return {
        eligible: false,
        language,
        reason: "too-short",
        detail: `${length.words} word(s), minimum ${config.minWords}`,
      };
    }
  } else if (length.characters < config.minChars) {
    return {
      eligible: false,
      language,
      reason: "too-short",
      detail: `${length.characters} character(s), minimum ${config.minChars}`,
    };
  }

  if (language === "native" && !config.reviewNativeLanguagePrompts) {
    return {
      eligible: false,
      language,
      reason: "native-prompts-disabled",
      detail: "native-language prompts are turned off",
    };
  }

  return { eligible: true, language, reason: "eligible", detail: `${language} prompt` };
}
