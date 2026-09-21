/**
 * Script classification and language tables.
 *
 * The extension is language-agnostic: it never hardcodes "English" or "Japanese". Instead the
 * user names a target and a native language in settings, and this module maps those names to the
 * character scripts used to tell the two apart locally (before any model call).
 */

export type ScriptClass =
  | "latin"
  | "kana"
  | "han"
  | "hangul"
  | "cyrillic"
  | "greek"
  | "arabic"
  | "hebrew"
  | "thai"
  | "devanagari";

export interface LanguageDefinition {
  /** Display name handed to the reviewer model. */
  name: string;
  /** Scripts this language is normally written in. */
  scripts: ScriptClass[];
  /** Whether words are separated by whitespace. Drives the minimum-length rule. */
  spaceDelimited: boolean;
}

export const LANGUAGES: Record<string, LanguageDefinition> = {
  en: { name: "English", scripts: ["latin"], spaceDelimited: true },
  ja: { name: "Japanese", scripts: ["kana", "han"], spaceDelimited: false },
  zh: { name: "Chinese", scripts: ["han"], spaceDelimited: false },
  ko: { name: "Korean", scripts: ["hangul", "han"], spaceDelimited: true },
  es: { name: "Spanish", scripts: ["latin"], spaceDelimited: true },
  fr: { name: "French", scripts: ["latin"], spaceDelimited: true },
  de: { name: "German", scripts: ["latin"], spaceDelimited: true },
  it: { name: "Italian", scripts: ["latin"], spaceDelimited: true },
  pt: { name: "Portuguese", scripts: ["latin"], spaceDelimited: true },
  nl: { name: "Dutch", scripts: ["latin"], spaceDelimited: true },
  sv: { name: "Swedish", scripts: ["latin"], spaceDelimited: true },
  pl: { name: "Polish", scripts: ["latin"], spaceDelimited: true },
  tr: { name: "Turkish", scripts: ["latin"], spaceDelimited: true },
  id: { name: "Indonesian", scripts: ["latin"], spaceDelimited: true },
  vi: { name: "Vietnamese", scripts: ["latin"], spaceDelimited: true },
  ru: { name: "Russian", scripts: ["cyrillic"], spaceDelimited: true },
  uk: { name: "Ukrainian", scripts: ["cyrillic"], spaceDelimited: true },
  el: { name: "Greek", scripts: ["greek"], spaceDelimited: true },
  ar: { name: "Arabic", scripts: ["arabic"], spaceDelimited: true },
  he: { name: "Hebrew", scripts: ["hebrew"], spaceDelimited: true },
  hi: { name: "Hindi", scripts: ["devanagari"], spaceDelimited: true },
  th: { name: "Thai", scripts: ["thai"], spaceDelimited: false },
};

export interface ResolvedLanguage {
  /** Normalized tag, e.g. "en". */
  tag: string;
  definition: LanguageDefinition;
}

/**
 * Accepts either a BCP-47-ish tag ("en", "ja") or a language name ("English", "Japanese").
 * Returns undefined for anything unrecognized so callers can surface the problem instead of
 * silently guessing.
 */
export function resolveLanguage(value: string): ResolvedLanguage | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return undefined;

  const byTag = LANGUAGES[trimmed];
  if (byTag) return { tag: trimmed, definition: byTag };

  // Language tags may carry a region or script subtag ("en-GB", "zh-Hans").
  const primary = trimmed.split(/[-_]/)[0];
  const byPrimaryTag = LANGUAGES[primary];
  if (byPrimaryTag) return { tag: primary, definition: byPrimaryTag };

  for (const [tag, definition] of Object.entries(LANGUAGES)) {
    if (definition.name.toLowerCase() === trimmed) return { tag, definition };
  }

  return undefined;
}

const SCRIPT_RANGES: Array<{ script: ScriptClass; ranges: Array<[number, number]> }> = [
  {
    script: "kana",
    ranges: [
      [0x3040, 0x309f],
      [0x30a0, 0x30ff],
      [0x31f0, 0x31ff],
      [0xff66, 0xff9d],
    ],
  },
  {
    script: "han",
    ranges: [
      [0x3400, 0x4dbf],
      [0x4e00, 0x9fff],
      [0xf900, 0xfaff],
      [0x20000, 0x2a6df],
    ],
  },
  {
    script: "hangul",
    ranges: [
      [0x1100, 0x11ff],
      [0x3130, 0x318f],
      [0xa960, 0xa97f],
      [0xac00, 0xd7af],
    ],
  },
  {
    script: "cyrillic",
    ranges: [
      [0x0400, 0x052f],
      [0x2de0, 0x2dff],
    ],
  },
  {
    script: "greek",
    ranges: [
      [0x0370, 0x03ff],
      [0x1f00, 0x1fff],
    ],
  },
  {
    script: "arabic",
    ranges: [
      [0x0600, 0x06ff],
      [0x0750, 0x077f],
      [0x08a0, 0x08ff],
    ],
  },
  { script: "hebrew", ranges: [[0x0590, 0x05ff]] },
  { script: "thai", ranges: [[0x0e00, 0x0e7f]] },
  { script: "devanagari", ranges: [[0x0900, 0x097f]] },
  {
    script: "latin",
    ranges: [
      [0x0041, 0x005a],
      [0x0061, 0x007a],
      [0x00c0, 0x024f],
      [0x1e00, 0x1eff],
    ],
  },
];

export function classifyScriptCharacter(codePoint: number): ScriptClass | undefined {
  for (const { script, ranges } of SCRIPT_RANGES) {
    for (const [start, end] of ranges) {
      if (codePoint >= start && codePoint <= end) return script;
    }
  }
  return undefined;
}

/** Character count per script class, ignoring whitespace, digits, and punctuation. */
export function countScripts(text: string): Map<ScriptClass, number> {
  const counts = new Map<ScriptClass, number>();
  for (const character of text) {
    const script = classifyScriptCharacter(character.codePointAt(0) ?? 0);
    if (!script) continue;
    counts.set(script, (counts.get(script) ?? 0) + 1);
  }
  return counts;
}

/**
 * The script covering the most characters, or undefined when the text carries no letters.
 *
 * Mixed prompts are decided by whichever script dominates. `ja` and `zh` both list `han`, so an
 * all-kanji prompt cannot be told apart from Chinese; it is treated as the native language when
 * that language claims `han`. The consequence is a harmless extra translation instead of a
 * missed one.
 */
export function dominantScript(text: string): ScriptClass | undefined {
  let winner: ScriptClass | undefined;
  let winnerCount = 0;
  for (const [script, count] of countScripts(text)) {
    if (count > winnerCount) {
      winner = script;
      winnerCount = count;
    }
  }
  return winner;
}

export function scriptedCharacterCount(text: string): number {
  let total = 0;
  for (const count of countScripts(text).values()) total += count;
  return total;
}
