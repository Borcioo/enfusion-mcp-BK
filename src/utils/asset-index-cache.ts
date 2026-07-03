import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
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

/** Cheap fingerprint of the loose asset tree: latest mtime across matching files + file count. */
export interface LooseFingerprint {
  mtimeMs: number;
  count: number;
}

/** Fingerprint of a single .pak archive (mtime + size — enough to detect replacement). */
export interface PakFingerprint {
  path: string;
  mtimeMs: number;
  size: number;
}

const CACHE_VERSION = 1;

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
 * Recursively walk the loose asset tree and compute a cheap fingerprint: the
 * newest mtime among asset-relevant files, plus a total count.
 *
 * This is per-FILE granularity (not per-directory) so that editing a single
 * file in place — without adding/removing anything — is still detected: its
 * mtime becomes the new "latest" and the fingerprint changes.
 *
 * It only stats matching files (no readFileSync, no entry object construction,
 * no GUID regex parsing), so it is far cheaper than a full buildIndex() pass.
 */
export function fingerprintLooseTree(basePath: string): LooseFingerprint {
  let latestMtimeMs = 0;
  let count = 0;

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
        count++;
        try {
          const mtimeMs = statSync(fullPath).mtimeMs;
          if (mtimeMs > latestMtimeMs) latestMtimeMs = mtimeMs;
        } catch {
          // Unreadable file — ignore, treat as unchanged.
        }
      }
    }
  }

  walk(basePath);
  return { mtimeMs: latestMtimeMs, count };
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

export function looseFingerprintsMatch(a: LooseFingerprint, b: LooseFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.count === b.count;
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
      typeof data.looseFingerprint.mtimeMs !== "number" ||
      typeof data.looseFingerprint.count !== "number" ||
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
