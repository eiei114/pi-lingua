import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Reading and writing Pi's `settings.json` files.
 *
 * `global` is Pi's agent settings file; `project` is `<cwd>/.pi/settings.json`. Pi resolves project
 * over global, so a value written to a file that does not already set the key can be shadowed by a
 * more specific file. Writes therefore follow the file that owns the key (see `writeLinguaSettings`).
 */

export type SettingsScope = "global" | "project";

export interface SettingsWriteOptions {
  cwd: string;
  /** Pi refuses project-settings writes in an untrusted project, so pi-lingua does too. */
  projectWritesAllowed: boolean;
}

export interface LinguaSettingsChange {
  /** Key path inside the `pi-lingua` block, e.g. `enabled` or `reviewer.model`. */
  keyPath: string;
  /** `undefined` removes the key so the next file, or the built-in default, applies again. */
  value?: unknown;
  /** `owner` (default) edits the file that wins; `all` edits every file that declares the key. */
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

/** The most specific settings file that sets `keyPath`, or `undefined` when no file does. */
export function linguaKeyOwner(cwd: string, keyPath: string): SettingsScope | undefined {
  if (declaresLinguaKey(readSettingsFile(settingsFilePath("project", cwd)), keyPath)) return "project";
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
 * Applies `pi-lingua` values to Pi's settings files.
 *
 * A key that a file already sets is edited in that file, because a write anywhere else would be
 * shadowed by it. Keys no file sets go to the global agent settings file, so a toggle survives
 * every project. Files that would not change are left untouched, and every other key in a written
 * file is preserved.
 */
export function writeLinguaSettings(
  changes: readonly LinguaSettingsChange[],
  options: SettingsWriteOptions,
): SettingsWrite[] {
  const grouped = new Map<SettingsScope, LinguaSettingsChange[]>();

  for (const change of changes) {
    for (const scope of targetScopes(change, options)) {
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

function targetScopes(change: LinguaSettingsChange, options: SettingsWriteOptions): SettingsScope[] {
  const projectOwns = declaresLinguaKey(
    readSettingsFile(settingsFilePath("project", options.cwd)),
    change.keyPath,
  );
  const globalOwns = declaresLinguaKey(
    readSettingsFile(settingsFilePath("global", options.cwd)),
    change.keyPath,
  );
  const writable: SettingsScope[] = [];
  if (projectOwns && options.projectWritesAllowed) writable.push("project");
  if (globalOwns) writable.push("global");

  if (change.targets === "all") return writable;
  if (writable.length > 0) return [writable[0]];
  return ["global"];
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

  return { scope, path, applied, removed, shadowed: isShadowed(scope, changes, options) };
}

/**
 * A write is shadowed when a more specific file sets the same key. That only happens when the
 * owning project file is present but the project is untrusted, so the value could not be edited.
 */
function isShadowed(
  scope: SettingsScope,
  changes: readonly LinguaSettingsChange[],
  options: SettingsWriteOptions,
): boolean {
  if (scope === "project") return false;
  const project = readSettingsFile(settingsFilePath("project", options.cwd));
  return changes.some((change) => declaresLinguaKey(project, change.keyPath));
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
