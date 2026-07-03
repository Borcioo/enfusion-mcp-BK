import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import {
  registerAssetSearch,
  invalidateAssetCache,
  __getBuildCountForTest,
} from "../../src/tools/asset-search.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { getCacheFilePath } from "../../src/utils/asset-index-cache.js";

const TEST_ROOT = resolve(import.meta.dirname, "../../tmp-test-asset-search-cache");
const CACHE_DIR = join(TEST_ROOT, "cache");

type Handler = (args: any) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeFakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

let counter = 0;
function makeGameDirs(): { gamePath: string; basePath: string } {
  counter++;
  const gamePath = join(TEST_ROOT, `game-${counter}`);
  const basePath = join(gamePath, "addons", "data");
  mkdirSync(basePath, { recursive: true });
  mkdirSync(join(gamePath, "addons"), { recursive: true });
  return { gamePath, basePath };
}

function makeConfig(gamePath: string): Config {
  return {
    ...loadConfig(),
    gamePath,
  };
}

function callAssetSearch(config: Config, args: Partial<{ query: string; type: string; limit: number; refresh: boolean }> = {}) {
  const { server, handlers } = makeFakeServer();
  registerAssetSearch(server, config);
  const handler = handlers.get("asset_search")!;
  return handler({ query: "Foo", type: "any", limit: 20, refresh: false, ...args });
}

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  process.env.ENFUSION_MCP_CACHE_DIR = CACHE_DIR;
  invalidateAssetCache();
  PakVirtualFS.invalidate();
});

afterEach(() => {
  delete process.env.ENFUSION_MCP_CACHE_DIR;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("asset_search persistent index cache", () => {
  it("persists the index to disk and reuses it on the next 'session' without rebuilding", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    const first = await callAssetSearch(config, { query: "Foo" });
    const after = __getBuildCountForTest();
    expect(after).toBe(before + 1);
    expect(getText(first)).toContain("Foo.et");

    // The persisted cache file should now exist.
    const cacheFile = getCacheFilePath(basePath, gamePath);
    expect(existsSync(cacheFile)).toBe(true);

    // Simulate a brand new session: drop the in-memory cache only.
    invalidateAssetCache();
    PakVirtualFS.invalidate();

    const second = await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    // No new full rebuild happened — loaded straight from the persisted cache.
    expect(afterSecond).toBe(after);
    expect(getText(second)).toBe(getText(first));
  });

  it("invalidates the persisted cache when a loose source file's mtime changes", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    const filePath = join(basePath, "Prefabs", "Foo.et");
    writeFileSync(filePath, "dummy");

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    // Touch the file's mtime into the future — content-in-place edit.
    const future = new Date(Date.now() + 60_000);
    utimesSync(filePath, future, future);

    await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("invalidates the persisted cache when a loose file is ADDED", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    // Add a brand-new asset file — count changes but max mtime alone might not
    // reliably move if clock resolution is coarse, so this specifically probes
    // the "new key added" staleness mode.
    writeFileSync(join(basePath, "Prefabs", "Bar.et"), "dummy");

    await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("invalidates the persisted cache when a loose file is REMOVED", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");
    const barPath = join(basePath, "Prefabs", "Bar.et");
    writeFileSync(barPath, "dummy");

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    // Remove a file — count changes but max mtime among remaining files is
    // unaffected, so this specifically probes the "key removed" staleness mode.
    rmSync(barPath);

    await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("invalidates the persisted cache when a loose file is RENAMED/MOVED with mtime preserved", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    mkdirSync(join(basePath, "Prefabs", "Weapons"), { recursive: true });
    const oldPath = join(basePath, "Prefabs", "Foo.et");
    writeFileSync(oldPath, "dummy");
    // Pin the mtime to a fixed, whole-second timestamp *before* the first
    // build, so that re-applying the exact same Date to the moved file below
    // round-trips through the filesystem identically (avoids sub-ms rounding
    // drift between the original write-time mtime and a later utimesSync
    // call, which could otherwise make the scalar fingerprint spuriously
    // differ for the wrong reason).
    const fixedMtime = new Date(Date.UTC(2020, 0, 1));
    utimesSync(oldPath, fixedMtime, fixedMtime);

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    // Simulate `mv`: same mtime, same total count, but the file now lives at a
    // different relative path. A scalar max(mtime)+count fingerprint cannot
    // detect this — the per-path map must.
    const newPath = join(basePath, "Prefabs", "Weapons", "Foo.et");
    const content = readFileSync(oldPath);
    rmSync(oldPath);
    writeFileSync(newPath, content);
    utimesSync(newPath, fixedMtime, fixedMtime);

    await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("invalidates the persisted cache when a .pak file's mtime changes", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");
    const pakPath = join(gamePath, "addons", "dummy.pak");
    writeFileSync(pakPath, "not a real pak, just needs a byte");

    const config = makeConfig(gamePath);

    const before = __getBuildCountForTest();
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    const future = new Date(Date.now() + 60_000);
    utimesSync(pakPath, future, future);

    await callAssetSearch(config, { query: "Foo" });
    const afterSecond = __getBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("rebuilds gracefully when the persisted cache file is corrupt", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");

    const config = makeConfig(gamePath);

    // Prime the cache path, then corrupt it.
    await callAssetSearch(config, { query: "Foo" });
    const cacheFile = getCacheFilePath(basePath, gamePath);
    expect(existsSync(cacheFile)).toBe(true);
    writeFileSync(cacheFile, "{ this is not valid json ][");

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    const before = __getBuildCountForTest();
    const result = await callAssetSearch(config, { query: "Foo" });
    const after = __getBuildCountForTest();

    // Corrupt cache → graceful rebuild, never a crash, never garbage results.
    expect(after).toBe(before + 1);
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("Foo.et");
  });

  it("rebuilds gracefully when the persisted cache has a schema mismatch", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");

    const config = makeConfig(gamePath);
    await callAssetSearch(config, { query: "Foo" });
    const cacheFile = getCacheFilePath(basePath, gamePath);
    writeFileSync(cacheFile, JSON.stringify({ totally: "wrong shape" }));

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    const before = __getBuildCountForTest();
    const result = await callAssetSearch(config, { query: "Foo" });
    const after = __getBuildCountForTest();

    expect(after).toBe(before + 1);
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("Foo.et");
  });

  it("refresh:true forces a full rebuild even when the persisted cache is valid", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Foo.et"), "dummy");

    const config = makeConfig(gamePath);
    await callAssetSearch(config, { query: "Foo" });
    const afterFirst = __getBuildCountForTest();

    // Cache is still valid (nothing changed) — but refresh:true must bypass it.
    await callAssetSearch(config, { query: "Foo", refresh: true });
    const afterRefresh = __getBuildCountForTest();

    expect(afterRefresh).toBe(afterFirst + 1);
  });

  it("returns identical results whether served from a cold build or the persisted cache", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs", "Weapons"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Weapons", "AK47.et"), "dummy");
    writeFileSync(join(basePath, "Prefabs", "Weapons", "AK74.et"), "dummy");

    const config = makeConfig(gamePath);

    const cold = await callAssetSearch(config, { query: "AK", limit: 10 });

    invalidateAssetCache();
    PakVirtualFS.invalidate();

    const warm = await callAssetSearch(config, { query: "AK", limit: 10 });

    expect(getText(warm)).toBe(getText(cold));
  });
});
