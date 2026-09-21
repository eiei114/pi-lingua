import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { expandHome, type LinguaConfig } from "../config.ts";
import type { PromptReview, VocabularySuggestion } from "../review.ts";
import {
  describeError,
  failed,
  skipped,
  type ReviewSink,
  type SinkResult,
} from "./types.ts";

export const ANKI_SINK_ID = "anki";
export const ANKI_CONNECT_TIMEOUT_MS = 2500;
export const ANKI_MODEL_NAME = "Basic";

/** Tab-separated columns Anki's file importer maps to Front / Back / Tags. */
export function renderAnkiTsvRows(review: PromptReview, deck: string): string {
  const tags = ["pi-lingua", review.targetLanguageTag, review.createdAt.slice(0, 10)]
    .filter(Boolean)
    .join(" ");
  return review.vocabulary
    .map((item) => `${item.from}\t${item.to}${item.gloss ? ` (${item.gloss})` : ""}\t${tags}\t${deck}`)
    .join("\n");
}

export function buildAnkiNote(item: VocabularySuggestion, review: PromptReview, deck: string): unknown {
  const back = item.gloss ? `${item.to} — ${item.gloss}` : item.to;
  return {
    action: "addNote",
    version: 6,
    params: {
      note: {
        deckName: deck,
        modelName: ANKI_MODEL_NAME,
        fields: { Front: item.from, Back: back },
        tags: ["pi-lingua", review.targetLanguageTag, review.createdAt.slice(0, 10)].filter(Boolean),
        options: { allowDuplicate: false, duplicateScope: "deck" },
      },
    },
  };
}

export interface AnkiConnectResponse {
  result?: unknown;
  error?: unknown;
}

export async function callAnkiConnect(
  endpoint: string,
  body: unknown,
  timeoutMs = ANKI_CONNECT_TIMEOUT_MS,
): Promise<AnkiConnectResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as AnkiConnectResponse;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AnkiConnect only exists when the add-on is installed and Anki is running, so this is probed
 * rather than assumed. A failed probe is never silent: the caller falls back to a TSV file and
 * reports the reason, because a review that quietly never reaches the deck is worse than an
 * explicit "install the add-on".
 */
export async function probeAnkiConnect(endpoint: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    const response = await callAnkiConnect(endpoint, { action: "version", version: 6 });
    if (response.error) return { ok: false, detail: String(response.error) };
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: describeError(error) };
  }
}

async function writeTsv(
  review: PromptReview,
  config: LinguaConfig,
  reason: string,
): Promise<SinkResult> {
  const path = expandHome(config.sinks.anki.tsvPath);
  const rows = renderAnkiTsvRows(review, config.sinks.anki.deck);
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${rows}\n`, "utf8");
    return {
      sinkId: ANKI_SINK_ID,
      status: "written",
      path,
      detail: `wrote ${review.vocabulary.length} card row(s) as TSV; ${reason}`,
    };
  } catch (error) {
    return failed(ANKI_SINK_ID, `${path}: ${describeError(error)}`);
  }
}

export const ankiSink: ReviewSink = {
  id: ANKI_SINK_ID,
  trigger: "manual",

  isEnabled(config: LinguaConfig): boolean {
    return config.sinks.anki.enabled;
  },

  async write(review: PromptReview, config: LinguaConfig): Promise<SinkResult> {
    if (review.vocabulary.length === 0) {
      return skipped(ANKI_SINK_ID, "this review has no vocabulary suggestions to add");
    }

    const { mode, endpoint, deck } = config.sinks.anki;

    if (mode === "tsv") {
      return writeTsv(review, config, "Anki file import maps Front / Back / Tags");
    }

    const probe = await probeAnkiConnect(endpoint);
    if (!probe.ok) {
      return writeTsv(
        review,
        config,
        `AnkiConnect did not answer at ${endpoint} (${probe.detail}); install and start the AnkiConnect add-on to push directly`,
      );
    }

    const added: string[] = [];
    for (const item of review.vocabulary) {
      try {
        const response = await callAnkiConnect(endpoint, buildAnkiNote(item, review, deck));
        if (response.error) return failed(ANKI_SINK_ID, `AnkiConnect: ${String(response.error)}`);
        added.push(item.from);
      } catch (error) {
        return failed(ANKI_SINK_ID, `AnkiConnect: ${describeError(error)}`);
      }
    }

    return {
      sinkId: ANKI_SINK_ID,
      status: "written",
      detail: `added ${added.length} note(s) to ${deck}: ${added.join(", ")}`,
    };
  },
};
