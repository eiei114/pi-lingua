import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Lingua reads and writes only Pi's agent-global settings. Legacy project blocks
 * are left untouched but never participate in resolution.
 */

export type SettingsScope = "global" | "project";

export interface SettingsWriteOptions {
  cwd: string;
  /** Retained for caller compatibility; project files are never written. */
  projectWritesAllowed: boolean;
}

export interface LinguaSettingsChange {
  /** Key path inside the `pi-lingua` block, e.g. `enabled` or `reviewer.model`. */
  keyPath: string;
  /** `undefined` removes the key so the next file, or the built-in default, applies again. */
  value?: unknown;
  /** Legacy hint; both choices now write only the global settings file. */
  targets?: "owner" | "all";
}

export interface SettingsWrite {
  scope: SettingsScope;
  path: string;
  applied: string[];
  removed: string[];
  /**
   * True when a more specific file still sets the key, so this write does not decide the value.
   * Only reachable when the owning project file cannot be written because it is not trusted.
   */
  shadowed: boolean;
}

const LINGUA_KEY = "pi-lingua";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Reads one settings file. A missing or malformed file reads as `undefined` rather than throwing. */
export function readSettingsFile(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a file that is about to be rewritten. A malformed file fails here instead of reading as
 * empty, because writing the merged result would silently discard everything the user had.
 */
function readSettingsFileForWrite(filePath: string): Record<string, unknown> | undefined {
  if (!existsSync(filePath)) return undefined;
  const parsed: unknown = JSON.parse(stripBom(readFileSync(filePath, "utf8")));
  if (!isRecord(parsed)) throw new Error(`${filePath} is not a JSON object`);
  return parsed;
}

export function settingsFilePath(scope: SettingsScope, cwd: string): string {
  return scope === "global"
    ? join(getAgentDir(), "settings.json")
    : join(cwd, ".pi", "settings.json");
}

/** True when this project carries a settings file, trusted or not. */
export function hasProjectSettings(cwd: string): boolean {
  return existsSync(settingsFilePath("project", cwd));
}

export function readLinguaBlock(
  document: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const block = document?.[LINGUA_KEY];
  return isRecord(block) ? block : undefined;
}

/** True when the `pi-lingua` block of this file sets `keyPath` (e.g. `reviewer.model`). */
export function declaresLinguaKey(
  document: Record<string, unknown> | undefined,
  keyPath: string,
): boolean {
  const path = splitKeyPath(keyPath);
  let current: unknown = readLinguaBlock(document);
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return false;
    current = current[part];
  }
  return true;
}

/** The global file if it declares this key; legacy project keys are ignored. */
export function linguaKeyOwner(cwd: string, keyPath: string): SettingsScope | undefined {
  if (declaresLinguaKey(readSettingsFile(settingsFilePath("global", cwd)), keyPath)) return "global";
  return undefined;
}

/** A path a reader can act on: `~` for the home directory, and project paths relative to `cwd`. */
export function displaySettingsPath(
  scope: SettingsScope,
  cwd: string,
  homeDirectory: string = process.env.HOME ?? process.env.USERPROFILE ?? "",
): string {
  const path = settingsFilePath(scope, cwd).replaceAll("\\", "/");
  if (scope === "project") return ".pi/settings.json";
  const home = homeDirectory.replaceAll("\\", "/");
  if (home && (path === home || path.startsWith(`${home}/`))) return `~${path.slice(home.length)}`;
  return path;
}

/**
 * Applies changes to the global agent settings while preserving unrelated keys.
 * Legacy project files are neither migrated nor modified implicitly.
 */
export function writeLinguaSettings(
  changes: readonly LinguaSettingsChange[],
  options: SettingsWriteOptions,
): SettingsWrite[] {
  const grouped = new Map<SettingsScope, LinguaSettingsChange[]>();

  for (const change of changes) {
    for (const scope of ["global"] as const) {
      const list = grouped.get(scope);
      if (list) list.push(change);
      else grouped.set(scope, [change]);
    }
  }

  const writes: SettingsWrite[] = [];
  for (const [scope, scopeChanges] of grouped) {
    const write = writeScope(scope, scopeChanges, options);
    if (write) writes.push(write);
  }
  return writes;
}

function writeScope(
  scope: SettingsScope,
  changes: readonly LinguaSettingsChange[],
  options: SettingsWriteOptions,
): SettingsWrite | undefined {
  const path = settingsFilePath(scope, options.cwd);
  const document: Record<string, unknown> = { ...(readSettingsFileForWrite(path) ?? {}) };
  const block: Record<string, unknown> = { ...(readLinguaBlock(document) ?? {}) };
  const applied: string[] = [];
  const removed: string[] = [];

  for (const change of changes) {
    const keys = splitKeyPath(change.keyPath);
    if (change.value === undefined) {
      if (deleteNestedKey(block, keys)) removed.push(change.keyPath);
      continue;
    }
    if (readNestedValue(block, keys) === change.value) continue;
    setNestedValue(block, keys, change.value);
    applied.push(change.keyPath);
  }

  if (applied.length === 0 && removed.length === 0) return undefined;

  const pruned = pruneEmptyBlock(block);
  if (pruned) document[LINGUA_KEY] = pruned;
  else delete document[LINGUA_KEY];

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  return { scope, path, applied, removed, shadowed: false };
}

function splitKeyPath(keyPath: string): string[] {
  return keyPath.split(".").filter(Boolean);
}

function readNestedValue(block: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = block;
  for (const part of path) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function setNestedValue(block: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let current = block;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (isRecord(next)) {
      current = next;
      continue;
    }
    const created: Record<string, unknown> = {};
    current[part] = created;
    current = created;
  }
  current[path[path.length - 1]] = value;
}

/** Removes a key and unwinds parent objects that became empty, so no `reviewer: {}` is left behind. */
function deleteNestedKey(block: Record<string, unknown>, path: readonly string[]): boolean {
  const parents: Record<string, unknown>[] = [block];
  let current = block;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (!isRecord(next)) return false;
    parents.push(next);
    current = next;
  }

  const last = path[path.length - 1];
  if (!Object.hasOwn(current, last)) return false;
  delete current[last];

  for (let index = parents.length - 1; index > 0; index -= 1) {
    if (Object.keys(parents[index]).length > 0) break;
    delete parents[index - 1][path[index - 1]];
  }
  return true;
}

function pruneEmptyBlock(block: Record<string, unknown>): Record<string, unknown> | undefined {
  return Object.keys(block).length > 0 ? block : undefined;
}
