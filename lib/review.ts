import type { LinguaConfig } from "./config.ts";
import { resolveLanguage } from "./languages.ts";
import type { PromptLanguage } from "./eligibility.ts";

export interface ReviewChange {
  from: string;
  to: string;
}

export interface VocabularySuggestion {
  from: string;
  to: string;
  gloss?: string;
}

export interface PromptReview {
  /** The prompt exactly as the user submitted it. */
  prompt: string;
  language: Exclude<PromptLanguage, "unknown">;
  targetLanguageName: string;
  targetLanguageTag: string;
  nativeLanguageName: string;
  /** The Target Language Rendering. */
  rendering: string;
  /** Optional for compatibility with saved reviews predating speaking guidance. */
  speaking?: { chunked: string; ipa: string; kana?: string };
  changes: ReviewChange[];
  note: string;
  vocabulary: VocabularySuggestion[];
  createdAt: string;
}

export interface ReviewerPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface ReviewerInput {
  text: string;
  language: Exclude<PromptLanguage, "unknown">;
  config: LinguaConfig;
}

/**
 * Text handed to the model is the user's prompt verbatim. The prompt explicitly forbids changing
 * intent, because the rendering is displayed and stored but never sent to the agent (see ADR-0001).
 */
export function buildReviewerPrompt(input: ReviewerInput): ReviewerPrompt {
  const target = resolveLanguage(input.config.targetLanguage);
  const native = resolveLanguage(input.config.nativeLanguage);
  const targetName = target?.definition.name ?? input.config.targetLanguage;
  const nativeName = native?.definition.name ?? input.config.nativeLanguage;
  const explainIn = input.config.explainIn === "target" ? targetName : nativeName;

  const direction =
    input.language === "native"
      ? `The prompt is written in ${nativeName}. Produce the ${targetName} version of it.`
      : `The prompt is written in ${targetName}. Produce the most natural, correct ${targetName} version of it.`;

  const changesRule =
    input.language === "native"
      ? `- The prompt is in ${nativeName}, so there is nothing to correct. Return an empty \`changes\` list. It is an error to list the translation itself as a change.`
      : "- Every entry in `changes` must be a fragment that literally appears in the input as written in `from`.";

  const systemPrompt = [
    "You review the wording of a single message a developer is about to send to a coding agent.",
    "You are not answering the message. You are reviewing how it is written.",
    "",
    direction,
    "",
    "Rules for `rendering` and `changes`:",
    "- Preserve the author's intent exactly. Never add, remove, or reinterpret a requirement.",
    "- Never turn the message into a better task. Only improve how it is expressed.",
    "- If the message is already natural and correct, return it unchanged with an empty changes list.",
    changesRule,
    "",
    `Rules for \`note\` and \`vocabulary\`:`,
    `- \`note\` MUST be written in ${explainIn}. This is not optional. A one-line English note is wrong when the answer is expected in ${explainIn}.`,
    `- If you are unsure how to phrase it in ${explainIn}, write a shorter ${explainIn} sentence instead of switching to English.`,
    "- The note must teach something about the wording: a rule, a register difference, or why one word is better. Do not narrate what you did.",
    '  Wrong: "I translated this into English." Wrong: "The sentence was improved." Right: "動詞で始めると指示が明確になる。"',
    `- Write \`gloss\` in ${explainIn} too.`,
    "- Offer vocabulary only when the alternative is genuinely more precise or more natural. Zero to two items.",
    "- Do not invent vocabulary to fill the list.",
    "",
    "Reply with JSON only, no prose and no code fences, in exactly this shape:",
    "Include `speaking` for the entire rendering, not just changed fragments. Preserve every word and punctuation in `chunked`, inserting ' / ' at natural speaking pauses. Use matching pauses in `ipa` (International Phonetic Alphabet, including stress where applicable). Never abbreviate or omit the end. This is model-generated pronunciation guidance, not audio verification.",
    native?.tag === "ja"
      ? "The native language is Japanese: also include `kana`, an approximate Katakana pronunciation of the entire target rendering with matching pauses. IPA is still required; kana does not replace IPA."
      : "The native language is not Japanese: omit `kana`; provide IPA pronunciation only.",
    "{",
    '  "rendering": "the full rewritten message",',
    '  "speaking": {"chunked": "full rendering with / pauses", "ipa": "full IPA with / pauses", "kana": "Japanese-native users only: approximate Katakana with / pauses"},',
    '  "changes": [{"from": "changed fragment as written", "to": "changed fragment"}] or [],',
    `  "note": "one short sentence, written in ${explainIn}",`,
    `  "vocabulary": [{"from": "word as written", "to": "better word", "gloss": "short meaning in ${explainIn}"}] or []`,
    "}",
  ].join("\n");

  return {
    systemPrompt,
    userPrompt: input.text,
  };
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fence ? fence[1] : trimmed;
}

/** Extracts the first balanced JSON object, tolerating leading or trailing model chatter. */
export function extractJsonObject(raw: string): string | undefined {
  const text = stripCodeFences(raw);
  const start = text.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

export const MAX_CHANGES = 2;
export const MAX_VOCABULARY = 2;
export const MAX_NOTE_LENGTH = 240;
export const MAX_RENDERING_LENGTH = 2000;

function parseChanges(value: unknown): ReviewChange[] {
  if (!Array.isArray(value)) return [];
  const changes: ReviewChange[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const from = asText(record.from, 400);
    const to = asText(record.to, 400);
    if (!from || !to) continue;
    changes.push({ from, to });
    if (changes.length >= MAX_CHANGES) break;
  }
  return changes;
}

function parseVocabulary(value: unknown): VocabularySuggestion[] {
  if (!Array.isArray(value)) return [];
  const vocabulary: VocabularySuggestion[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (!record) continue;
    const from = asText(record.from, 80);
    const to = asText(record.to, 80);
    if (!from || !to) continue;
    const gloss = asText(record.gloss, 120);
    vocabulary.push(gloss ? { from, to, gloss } : { from, to });
    if (vocabulary.length >= MAX_VOCABULARY) break;
  }
  return vocabulary;
}

export interface ParseReviewOptions {
  prompt: string;
  language: Exclude<PromptLanguage, "unknown">;
  config: LinguaConfig;
  createdAt?: string;
}

/** Reject incomplete or oversized guides rather than silently cutting off pronunciation. */
function parseSpeaking(value: unknown, rendering: string, japanese: boolean): PromptReview["speaking"] {
  const record = asRecord(value);
  if (!record) return undefined;
  const fullText = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() && value.length <= 12000 ? value.trim() : undefined;
  const chunked = fullText(record.chunked);
  const ipa = fullText(record.ipa);
  const kana = japanese ? fullText(record.kana) : undefined;
  const normalize = (text: string): string => text.replace(/\s\/\s/g, " ").replace(/\s/g, "");
  if (!chunked || !ipa || normalize(chunked) !== normalize(rendering)) return undefined;
  return { chunked, ipa, ...(kana ? { kana } : {}) };
}

/**
 * Normalizes model output into a PromptReview. Returns undefined when the response cannot be
 * understood, so the caller can report a failure instead of showing a half-filled widget.
 */
export function parseReviewResponse(raw: string, options: ParseReviewOptions): PromptReview | undefined {
  const json = extractJsonObject(raw);
  if (!json) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  const record = asRecord(parsed);
  if (!record) return undefined;

  const rendering = asText(record.rendering, MAX_RENDERING_LENGTH);
  if (!rendering) return undefined;

  const target = resolveLanguage(options.config.targetLanguage);
  const native = resolveLanguage(options.config.nativeLanguage);

  const changes = parseChanges(record.changes);
  const note = asText(record.note, MAX_NOTE_LENGTH) ?? "";

  return {
    prompt: options.prompt,
    language: options.language,
    targetLanguageName: target?.definition.name ?? options.config.targetLanguage,
    targetLanguageTag: target?.tag ?? options.config.targetLanguage,
    nativeLanguageName: native?.definition.name ?? options.config.nativeLanguage,
    rendering,
    speaking: parseSpeaking(record.speaking, rendering, native?.tag === "ja"),
    changes,
    note,
    vocabulary: parseVocabulary(record.vocabulary),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
}

/** Collects the text blocks of an assistant message. */
export function extractAssistantText(message: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return message.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}
