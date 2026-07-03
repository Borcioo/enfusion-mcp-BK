import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { logger } from "./logger.js";
import { getCacheDir } from "./asset-index-cache.js";
import type { LooseFingerprint, PakFingerprint } from "./asset-index-cache.js";
import type { ComponentMatrix } from "../index/component-matrix.js";

// Bumped whenever the on-disk payload shape changes — a cache written under
// an older schema must be rejected and rebuilt rather than misread.
const CACHE_VERSION = 1;

export interface ComponentMatrixCachePayload {
  version: number;
  basePath: string;
  gamePath: string;
  looseFingerprint: LooseFingerprint;
  pakFingerprints: PakFingerprint[];
  matrix: ComponentMatrix;
}

/** Deterministic cache file path for a given (basePath, gamePath) pair. Lives alongside the asset index cache. */
export function getComponentMatrixCacheFilePath(basePath: string, gamePath: string): string {
  const hash = createHash("sha1").update(`${basePath}|${gamePath}`).digest("hex").slice(0, 16);
  return join(getCacheDir(), `component-matrix-${hash}.json`);
}

/**
 * Load the persisted component matrix for (basePath, gamePath), if present,
 * readable and schema-valid. Returns null on any failure (missing file,
 * corrupt JSON, schema mismatch) so callers can fall back to a full rebuild.
 */
export function loadPersistedComponentMatrix(
  basePath: string,
  gamePath: string
): ComponentMatrixCachePayload | null {
  const filePath = getComponentMatrixCacheFilePath(basePath, gamePath);
  if (!existsSync(filePath)) return null;

  try {
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as Partial<ComponentMatrixCachePayload>;
    if (
      data.version !== CACHE_VERSION ||
      data.basePath !== basePath ||
      data.gamePath !== gamePath ||
      !data.matrix ||
      typeof data.matrix !== "object" ||
      Array.isArray(data.matrix) ||
      !data.looseFingerprint ||
      typeof data.looseFingerprint !== "object" ||
      Array.isArray(data.looseFingerprint) ||
      !Object.values(data.looseFingerprint).every((v) => typeof v === "number") ||
      !Array.isArray(data.pakFingerprints)
    ) {
      logger.warn(`Component matrix cache schema mismatch at ${filePath}, ignoring`);
      return null;
    }
    return data as ComponentMatrixCachePayload;
  } catch (e) {
    logger.warn(`Component matrix cache unreadable/corrupt at ${filePath}, ignoring: ${e}`);
    return null;
  }
}

/** Persist the built matrix + fingerprints to disk. Failures are logged, never thrown. */
export function savePersistedComponentMatrix(payload: Omit<ComponentMatrixCachePayload, "version">): void {
  const filePath = getComponentMatrixCacheFilePath(payload.basePath, payload.gamePath);
  try {
    mkdirSync(getCacheDir(), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: CACHE_VERSION, ...payload }), "utf-8");
  } catch (e) {
    logger.warn(`Failed to write component matrix cache to ${filePath}: ${e}`);
  }
}
