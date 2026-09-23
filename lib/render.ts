import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExplainLanguage } from "./config.ts";
import type { PromptReview } from "./review.ts";

export const DEFAULT_WIDGET_WIDTH = 72;

export interface RenderReviewOptions {
  explainIn: ExplainLanguage;
  width?: number;
}

export type ReviewWidgetSectionKind =
  | "source"
  | "rendering"
  | "changes"
  | "speaking"
  | "note"
  | "vocabulary";

export interface ReviewWidgetSection {
  kind: ReviewWidgetSectionKind;
  lines: string[];
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;
const QUOTED_PATH_PATTERN = /(["'`])([^"'`\n]+)\1/g;
const PATH_PREFIX_CHARACTERS = new Set(["=", ":", "(", "[", "{", "<", '"', "'", "`"]);
const URL_MARKER_PATTERN = /\uE000(\d+)\uE001/g;
const URL_COMPACT_THRESHOLD = 42;
const FILE_PATH_COMPACT_THRESHOLD = 32;

/** Keep widget source excerpts readable without letting references dominate them. */
function compactWidgetSource(text: string): string {
  const urls: string[] = [];
  const protectedText = text.replace(URL_PATTERN, (url) => {
    const index = urls.push(url) - 1;
    return `\uE000${index}\uE001`;
  });

  const compactedQuotedPaths = protectedText.replace(
    QUOTED_PATH_PATTERN,
    (whole: string, quote: string, path: string) => {
      const compacted = compactFilePath(path);
      return compacted === path ? whole : `${quote}${compacted}${quote}`;
    },
  );
  const compactedPaths = compactedQuotedPaths.replace(/\S+/g, compactFilePathInToken);

  return compactedPaths.replace(URL_MARKER_PATTERN, (_marker, index: string) =>
    compactUrl(urls[Number(index)] ?? ""),
  );
}

function compactFilePathInToken(token: string): string {
  const starts: number[] = [];
  for (let index = 1; index < token.length; index += 1) {
    const previous = token[index - 1] ?? "";
    const current = token[index] ?? "";
    if (!PATH_PREFIX_CHARACTERS.has(previous)) continue;
    if (
      previous === ":" &&
      /^[A-Za-z]$/.test(token[index - 2] ?? "") &&
      isPathSeparator(current)
    ) {
      continue;
    }
    starts.push(index);
  }
  starts.push(0);

  for (const start of starts) {
    const path = token.slice(start);
    const compacted = compactFilePath(path);
    if (compacted !== path) return `${token.slice(0, start)}${compacted}`;
  }
  return token;
}

function compactFilePath(value: string): string {
  const { path, punctuation } = splitTrailingPathPunctuation(value);
  if (path.length <= FILE_PATH_COMPACT_THRESHOLD) return value;

  const segments = path.replaceAll("\\", "/").split("/").filter(Boolean);
  const filename = segments.at(-1) ?? "";
  const filenameWithoutLine = filename.replace(/:\d+(?::\d+)?$/, "");
  const extension = filenameWithoutLine.slice(filenameWithoutLine.lastIndexOf("."));
  if (
    segments.length < 2 ||
    (segments.length < 3 && !/^\.[A-Za-z0-9]{1,12}$/.test(extension))
  ) {
    return value;
  }

  return `…/${segments.slice(-2).join("/")}${punctuation}`;
}

function isPathSeparator(value: string): boolean {
  return value === "/" || value === "\\";
}

function splitTrailingPathPunctuation(value: string): { path: string; punctuation: string } {
  let end = value.length;
  while (end > 0 && /[.,!?;:)'"`\]}]/.test(value[end - 1] ?? "")) end -= 1;
  return { path: value.slice(0, end), punctuation: value.slice(end) };
}

function compactUrl(value: string): string {
  const { url, punctuation } = splitTrailingPunctuation(value);
  if (url.length <= URL_COMPACT_THRESHOLD) return value;

  try {
    const isWww = /^www\./i.test(url);
    const parsed = new URL(isWww ? `https://${url}` : url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const suffix = segments.slice(-2).join("/");
    const path = suffix ? `/…/${suffix}` : "/…";
    const query = parsed.search ? "?…" : "";
    const hash = parsed.hash ? "#…" : "";
    const origin = isWww ? `www.${parsed.host}` : `${parsed.protocol}//${parsed.host}`;
    const compacted = `${origin}${path}${query}${hash}`;
    return compacted.length < url.length ? `${compacted}${punctuation}` : value;
  } catch {
    return value;
  }
}

function splitTrailingPunctuation(value: string): { url: string; punctuation: string } {
  let end = value.length;
  while (end > 0 && /[.,!?;)]/.test(value[end - 1] ?? "")) {
    if (value[end - 1] === ")") {
      const candidate = value.slice(0, end);
      const opens = candidate.match(/\(/g)?.length ?? 0;
      const closes = candidate.match(/\)/g)?.length ?? 0;
      if (closes <= opens) break;
    }
    end -= 1;
  }
  return { url: value.slice(0, end), punctuation: value.slice(end) };
}

/** Shared full-text speaking guidance for widgets, transcript entries, and logs. */
export function renderSpeakingGuide(review: PromptReview): string[] {
  if (!review.speaking) return [];
  return [
    `Speak: ${review.speaking.chunked}`,
    `IPA: ${review.speaking.ipa}`,
    ...(review.speaking.kana ? [`カナ（目安）: ${review.speaking.kana}`] : []),
  ];
}

/** Widget preview: preserve prose, compact long references, then wrap to terminal width. */
export function renderReviewWidget(review: PromptReview, options: RenderReviewOptions): string[] {
  const width = options.width ?? DEFAULT_WIDGET_WIDTH;
  return renderReviewWidgetSections(review)
    .flatMap((section) => section.lines)
    .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
}

/** Structured widget content lets the host style sections without changing review text. */
export function renderReviewWidgetSections(review: PromptReview): ReviewWidgetSection[] {
  const targetTag = review.targetLanguageTag.toUpperCase();
  const sections: ReviewWidgetSection[] = [];

  if (review.language === "native") {
    const nativeTag = review.nativeLanguageName.slice(0, 2).toUpperCase();
    sections.push({
      kind: "source",
      lines: [`${nativeTag} → ${targetTag}`, `> ${compactWidgetSource(review.prompt)}`],
    });
    sections.push({ kind: "rendering", lines: [`+ ${review.rendering}`] });
  } else {
    if (review.changes.length > 0) {
      const lines = [`${targetTag} review`];
      for (const change of review.changes) {
        lines.push(`- ${compactWidgetSource(change.from)}`);
        lines.push(`+ ${change.to}`);
      }
      sections.push({ kind: "changes", lines });
    } else {
      sections.push({ kind: "rendering", lines: [`${targetTag} review`, `ok  ${review.rendering}`] });
    }
  }

  const speaking = renderSpeakingGuide(review);
  if (speaking.length > 0) sections.push({ kind: "speaking", lines: speaking });
  if (review.note) sections.push({ kind: "note", lines: [review.note] });

  if (review.vocabulary.length > 0) {
    const lines = ["", "◆ vocab"];
    for (const item of review.vocabulary) {
      const gloss = item.gloss ? `  ${item.gloss}` : "";
      lines.push(`  ${item.from} → ${item.to}${gloss}`);
    }
    sections.push({ kind: "vocabulary", lines });
  }

  return sections;
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
  lines.push(...renderSpeakingGuide(review));

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
