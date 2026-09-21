import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type ExplainLanguage = "native" | "target";

export interface ReviewerRoute {
  provider?: string;
  model?: string;
}

export interface ReviewLogSinkConfig {
  enabled: boolean;
  dir: string;
}

export interface AnkiSinkConfig {
  enabled: boolean;
  mode: "ankiconnect" | "tsv";
  deck: string;
  endpoint: string;
  tsvPath: string;
}

export interface LinguaSinksConfig {
  reviewLog: ReviewLogSinkConfig;
  anki: AnkiSinkConfig;
}

export interface LinguaConfig {
  targetLanguage: string;
  nativeLanguage: string;
  explainIn: ExplainLanguage;
  minWords: number;
  minChars: number;
  reviewNativeLanguagePrompts: boolean;
  reviewer: ReviewerRoute;
  sinks: LinguaSinksConfig;
}

/**
 * The default destination. It resolves through Pi's own agent directory, so it works on any
 * machine without configuration and never assumes a particular vault layout.
 */
export function defaultReviewLogDir(): string {
  return join(getAgentDir(), "lingua", "reviews");
}

export function defaultAnkiTsvPath(): string {
  return join(getAgentDir(), "lingua", "anki-cards.tsv");
}

export function createDefaultConfig(): LinguaConfig {
  return {
    targetLanguage: "en",
    nativeLanguage: "ja",
    explainIn: "native",
    minWords: 3,
    minChars: 6,
    reviewNativeLanguagePrompts: true,
    reviewer: {},
    sinks: {
      reviewLog: { enabled: true, dir: defaultReviewLogDir() },
      anki: {
        enabled: false,
        mode: "ankiconnect",
        deck: "English::PromptReview",
        endpoint: "http://127.0.0.1:8765",
        tsvPath: defaultAnkiTsvPath(),
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSettingsFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringOr(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function positiveIntegerOr(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : fallback;
}

function explainLanguageOr(value: unknown, fallback: ExplainLanguage): ExplainLanguage {
  return value === "native" || value === "target" ? value : fallback;
}

function ankiModeOr(value: unknown, fallback: AnkiSinkConfig["mode"]): AnkiSinkConfig["mode"] {
  return value === "ankiconnect" || value === "tsv" ? value : fallback;
}

/**
 * Applies one settings block over a base config. Unknown keys are ignored rather than rejected so
 * a config written for a newer version still loads.
 */
export function applyOverrides(base: LinguaConfig, raw: unknown): LinguaConfig {
  if (!isRecord(raw)) return base;

  const sinks = isRecord(raw.sinks) ? raw.sinks : {};
  const reviewLog = isRecord(sinks.reviewLog) ? sinks.reviewLog : {};
  const anki = isRecord(sinks.anki) ? sinks.anki : {};
  const reviewer = isRecord(raw.reviewer) ? raw.reviewer : {};

  return {
    targetLanguage: stringOr(raw.targetLanguage, base.targetLanguage),
    nativeLanguage: stringOr(raw.nativeLanguage, base.nativeLanguage),
    explainIn: explainLanguageOr(raw.explainIn, base.explainIn),
    minWords: positiveIntegerOr(raw.minWords, base.minWords),
    minChars: positiveIntegerOr(raw.minChars, base.minChars),
    reviewNativeLanguagePrompts: booleanOr(
      raw.reviewNativeLanguagePrompts,
      base.reviewNativeLanguagePrompts,
    ),
    reviewer: {
      provider: optionalString(reviewer.provider) ?? base.reviewer.provider,
      model: optionalString(reviewer.model) ?? base.reviewer.model,
    },
    sinks: {
      reviewLog: {
        enabled: booleanOr(reviewLog.enabled, base.sinks.reviewLog.enabled),
        dir: stringOr(reviewLog.dir, base.sinks.reviewLog.dir),
      },
      anki: {
        enabled: booleanOr(anki.enabled, base.sinks.anki.enabled),
        mode: ankiModeOr(anki.mode, base.sinks.anki.mode),
        deck: stringOr(anki.deck, base.sinks.anki.deck),
        endpoint: stringOr(anki.endpoint, base.sinks.anki.endpoint),
        tsvPath: stringOr(anki.tsvPath, base.sinks.anki.tsvPath),
      },
    },
  };
}

/**
 * Resolution order: defaults, then agent settings, then project settings. The project wins
 * because it is the most specific thing the user just opened.
 */
export function loadLinguaConfig(cwd: string): LinguaConfig {
  const withDefaults = createDefaultConfig();
  const agentSettings = readSettingsFile(join(getAgentDir(), "settings.json"));
  const projectSettings = readSettingsFile(join(cwd, ".pi", "settings.json"));

  const afterAgent = applyOverrides(withDefaults, agentSettings?.["pi-lingua"]);
  return applyOverrides(afterAgent, projectSettings?.["pi-lingua"]);
}

/** Expands a leading `~` so settings can be written the way a shell user expects. */
export function expandHome(path: string, homeDirectory: string = process.env.HOME ?? process.env.USERPROFILE ?? ""): string {
  if (path === "~") return homeDirectory || path;
  if (path.startsWith("~/") || path.startsWith("~\\")) {
    return homeDirectory ? join(homeDirectory, path.slice(2)) : path;
  }
  return path;
}
