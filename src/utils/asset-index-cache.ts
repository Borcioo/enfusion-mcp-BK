import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";

/** Extensions considered part of the asset index — mirrors asset-search.ts's filter. */
export const ASSET_EXTENSIONS = new Set([".et", ".xob", ".edds", ".c", ".conf", ".emat", ".layout", ".sounds"]);

export interface AssetEntry {
  path: string;
  ext: string;
  guid?: string;
}

/**
 * Fingerprint of the loose asset tree: a per-relative-path map of mtimeMs for
 * every file matching ASSET_EXTENSIONS under the scanned base. Relative paths
 * (with forward slashes, portable across OSes) are used as keys so that the
 * fingerprint is stable across machines and so that a rename/move (same
 * content+mtime, different path) is visible as "old key gone, new key
 * present" — a scalar max(mtime)+count fingerprint cannot see that.
 */
export type LooseFingerprint = Record<string, number>;

/** Fingerprint of a single .pak archive (mtime + size — enough to detect replacement). */
export interface PakFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
}

// Bumped to 2: LooseFingerprint changed from a scalar { mtimeMs, count } to a
// per-path map { [relativePath]: mtimeMs }. Any cache written under the old
// schema must be rejected and rebuilt rather than misread.
const CACHE_VERSION = 2;

export interface AssetIndexCachePayload {
  version: number;
  basePath: string;
  gamePath: string;
  looseFingerprint: LooseFingerprint;
  pakFingerprints: PakFingerprint[];
  entries: AssetEntry[];
  guidDiag: string;
}

/** Directory where persistent cache files live. Overridable via env var for tests/CI isolation. */
export function getCacheDir(): string {
  return process.env.ENFUSION_MCP_CACHE_DIR || join(homedir(), ".enfusion-mcp", "cache");
}

/** Deterministic cache file path for a given (basePath, gamePath) pair. */
export function getCacheFilePath(basePath: string, gamePath: string): string {
  const hash = createHash("sha1").update(`${basePath}|${gamePath}`).digest("hex").slice(0, 16);
  return join(getCacheDir(), `asset-index-${hash}.json`);
}

/**
 * Recursively walk the loose asset tree and compute a per-path fingerprint:
 * relative-path -> mtimeMs for every asset-relevant file.
 *
 * This is per-FILE granularity, keyed by path (not folded into a scalar
 * max+count), so it detects all three staleness modes:
 *  - in-place edit: the file's key keeps its path but its mtimeMs value changes
 *  - add: a new key appears
 *  - remove: an existing key disappears
 *  - rename/move (e.g. `mv`, which preserves mtime): the old key disappears
 *    and a new key appears at the same time — a scalar max(mtime)+count
 *    fingerprint is blind to this because count is unchanged and the moved
 *    file's mtime, unchanged by the move, doesn't move the tracked max.
 *
 * Paths are stored relative to basePath with forward slashes so the
 * fingerprint is portable/stable across machines and OSes.
 *
 * It only stats matching files (no readFileSync, no entry object construction,
 * no GUID regex parsing), so it is far cheaper than a full buildIndex() pass.
 */
export function fingerprintLooseTree(basePath: string): LooseFingerprint {
  const fingerprint: LooseFingerprint = {};

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (!ASSET_EXTENSIONS.has(ext)) continue;
        try {
          const mtimeMs = statSync(fullPath).mtimeMs;
          const relPath = relative(basePath, fullPath).split(sep).join("/");
          fingerprint[relPath] = mtimeMs;
        } catch {
          // Unreadable file — ignore, treat as unchanged.
        }
      }
    }
  }

  walk(basePath);
  return fingerprint;
}

/**
 * Fingerprint every .pak archive under gamePath/addons (top-level + one level
 * deep, mirroring PakVirtualFS's scan order). Sorted by path for a stable
 * comparison.
 */
export function fingerprintPaks(gamePath: string): PakFingerprint[] {
  const addonsPath = join(gamePath, "addons");
  const paks: PakFingerprint[] = [];

  function collect(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".pak") continue;
      const fullPath = join(dir, entry.name);
      try {
        const st = statSync(fullPath);
        paks.push({ path: fullPath, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // Unreadable pak — ignore.
      }
    }
  }

  collect(addonsPath);
  try {
    const topEntries = readdirSync(addonsPath, { withFileTypes: true });
    for (const entry of topEntries) {
      if (entry.isDirectory()) collect(join(addonsPath, entry.name));
    }
  } catch {
    // No addons dir — no paks.
  }

  paks.sort((a, b) => a.path.localeCompare(b.path));
  return paks;
}

/**
 * Deep-equality check for two per-path loose fingerprints: fresh only if both
 * have the same set of keys AND the same mtimeMs per key. This catches
 * in-place edits (value differs), adds/removes (key set differs), and
 * renames/moves (old key gone + new key present, even though nothing else
 * about the file changed).
 */
export function looseFingerprintsMatch(a: LooseFingerprint, b: LooseFingerprint): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export function pakFingerprintsMatch(a: PakFingerprint[], b: PakFingerprint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].path !== b[i].path || a[i].mtimeMs !== b[i].mtimeMs || a[i].size !== b[i].size) return false;
  }
  return true;
}

/**
 * Load the persisted cache for (basePath, gamePath), if present, readable and
 * schema-valid. Returns null on any failure (missing file, corrupt JSON,
 * schema mismatch) so callers can fall back to a full rebuild — a stale or
 * malformed cache must never be served.
 */
export function loadPersistedIndex(basePath: string, gamePath: string): AssetIndexCachePayload | null {
  const filePath = getCacheFilePath(basePath, gamePath);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Partial<AssetIndexCachePayload>;
    if (
      data.version !== CACHE_VERSION ||
      data.basePath !== basePath ||
      data.gamePath !== gamePath ||
      !Array.isArray(data.entries) ||
      !data.looseFingerprint ||
      typeof data.looseFingerprint !== "object" ||
      Array.isArray(data.looseFingerprint) ||
      !Object.values(data.looseFingerprint).every((v) => typeof v === "number") ||
      !Array.isArray(data.pakFingerprints)
    ) {
      logger.warn(`Asset index cache schema mismatch at ${filePath}, ignoring`);
      return null;
    }
    return data as AssetIndexCachePayload;
  } catch (e) {
    logger.warn(`Asset index cache unreadable/corrupt at ${filePath}, ignoring: ${e}`);
    return null;
  }
}

/** Persist the built index + fingerprints to disk. Failures are logged, never thrown. */
export function savePersistedIndex(payload: Omit<AssetIndexCachePayload, "version">): void {
  const filePath = getCacheFilePath(payload.basePath, payload.gamePath);
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: CACHE_VERSION, ...payload }), "utf-8");
  } catch (e) {
    logger.warn(`Failed to write asset index cache to ${filePath}: ${e}`);
  }
}
