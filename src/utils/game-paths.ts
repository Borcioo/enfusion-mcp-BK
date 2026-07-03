import { readdirSync, existsSync } from "node:fs";
import { resolve, join, sep } from "node:path";

/**
 * Resolve the game data directory (loose/extracted files).
 * Tries gamePath/addons/data first (standard Steam install), then gamePath/addons.
 */
export function resolveGameDataPath(gamePath: string): string | null {
  const dataPath = join(gamePath, "addons", "data");
  if (existsSync(dataPath)) return dataPath;
  const addonsPath = join(gamePath, "addons");
  if (existsSync(addonsPath)) return addonsPath;
  return null;
}

/**
 * Find a loose file in the game data directory.
 * Handles paths with DataXXX prefix ("Data006/Prefabs/...") and bare paths ("Prefabs/...").
 */
export function findLooseFile(gameDataPath: string, relativePath: string): string | null {
  const direct = join(gameDataPath, relativePath);
  if (existsSync(direct)) return direct;

  if (!relativePath.startsWith("Data")) {
    try {
      const entries = readdirSync(gameDataPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith("Data")) continue;
        const candidate = join(gameDataPath, entry.name, relativePath);
        if (existsSync(candidate)) return candidate;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

/** Find the addon directory: by modName (folder name) or first addon with a .gproj. */
export function resolveAddonDir(projectPath: string, modName?: string): string | null {
  if (modName) {
    const base = resolve(projectPath);
    const dir = resolve(base, modName);
    // Prevent path traversal — modName must not escape projectPath
    if (dir !== base && !dir.startsWith(base + sep)) return null;
    return existsSync(dir) ? dir : null;
  }
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(projectPath, entry.name);
      if (findGproj(dir)) return dir;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Find a .gproj file directly inside a directory (no recursion). */
export function findGprojDirect(dir: string): string | null {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory() && e.name.endsWith(".gproj")) {
        return join(dir, e.name);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Find the first .gproj file for an addon directory.
 * Checks the directory root first, then falls back to one level of
 * subdirectories — some addons (e.g. Central-Economy) keep the .gproj in a
 * nested `source/` folder rather than at the addon root.
 */
export function findGproj(dir: string): string | null {
  const direct = findGprojDirect(dir);
  if (direct) return direct;

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const nested = findGprojDirect(join(dir, e.name));
      if (nested) return nested;
    }
  } catch {
    // ignore
  }

  return null;
}

/** An addon folder discovered under a multi-mod workspace directory. */
export interface AddonEntry {
  /** Folder name (relative to the workspace projectPath). */
  name: string;
  /** Whether a .gproj file was found for this addon (root or one level deep). */
  hasGproj: boolean;
  /** Absolute path to the .gproj file, if found. */
  gprojPath: string | null;
}

/**
 * List addon folders under a multi-mod workspace directory.
 * Returns every top-level directory, flagging which ones contain a .gproj
 * (directly or one level deep, e.g. `<addon>/source/*.gproj`) so callers can
 * distinguish real addons from other folders.
 */
export function listAddons(projectPath: string): AddonEntry[] {
  const results: AddonEntry[] = [];
  try {
    const entries = readdirSync(projectPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(projectPath, entry.name);
      const gprojPath = findGproj(dir);
      results.push({ name: entry.name, hasGproj: gprojPath !== null, gprojPath });
    }
  } catch {
    // ignore
  }
  return results;
}
