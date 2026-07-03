import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import {
  registerComponentSearch,
  invalidateComponentMatrixCache,
  __getMatrixBuildCountForTest,
} from "../../src/tools/component-search.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import {
  getComponentMatrixCacheFilePath,
  loadPersistedComponentMatrix,
  savePersistedComponentMatrix,
} from "../../src/utils/component-matrix-cache.js";

const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../data");
const searchEngine = new SearchEngine(dataDir);

const TEST_ROOT = resolve(import.meta.dirname, "../../tmp-test-component-matrix");
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
  return { ...loadConfig(), gamePath };
}

function callComponentSearch(config: Config, args: Record<string, unknown> = {}) {
  const { server, handlers } = makeFakeServer();
  registerComponentSearch(server, searchEngine, config);
  const handler = handlers.get("component_search")!;
  return handler({ category: "any", source: "all", limit: 20, refresh: false, ...args });
}

const WEAPON_ET = `GenericEntity {
  components {
   MeshObject "{AAAAAAAAAAAAAAAA}" {
    Object "weapon1.xob"
   }
   SCR_WeaponComponent "{BBBBBBBBBBBBBBBB}" {
   }
  }
}`;

const WEAPON_ET_2 = `GenericEntity {
  components {
   MeshObject "{CCCCCCCCCCCCCCCC}" {
    Object "weapon2.xob"
   }
   SCR_WeaponComponent "{DDDDDDDDDDDDDDDD}" {
   }
   RplComponent "{EEEEEEEEEEEEEEEE}" {
   }
  }
}`;

beforeEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(CACHE_DIR, { recursive: true });
  process.env.ENFUSION_MCP_CACHE_DIR = CACHE_DIR;
  invalidateComponentMatrixCache();
  PakVirtualFS.invalidate();
});

afterEach(() => {
  delete process.env.ENFUSION_MCP_CACHE_DIR;
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("component_search entityType mode", () => {
  it("returns components ranked by co-occurrence for a known entity type", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs", "Weapons"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "Weapons", "W1.et"), WEAPON_ET);
    writeFileSync(join(basePath, "Prefabs", "Weapons", "W2.et"), WEAPON_ET_2);

    const config = makeConfig(gamePath);
    const result = await callComponentSearch(config, { entityType: "GenericEntity" });
    const text = getText(result);

    expect(text).toContain("MeshObject");
    expect(text).toContain("SCR_WeaponComponent");
    expect(text).toContain("RplComponent");
    expect(result.isError).toBeFalsy();
  });

  it("returns an empty/no-results response for an unknown entity type", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "W1.et"), WEAPON_ET);

    const config = makeConfig(gamePath);
    const result = await callComponentSearch(config, { entityType: "TotallyUnknownEntityType" });
    const text = getText(result);

    expect(text.toLowerCase()).toMatch(/no .*found|unknown/);
    expect(result.isError).toBeFalsy();
  });

  it("persists the matrix to disk and reuses it on the next session without rebuilding", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "W1.et"), WEAPON_ET);

    const config = makeConfig(gamePath);

    const before = __getMatrixBuildCountForTest();
    await callComponentSearch(config, { entityType: "GenericEntity" });
    const after = __getMatrixBuildCountForTest();
    expect(after).toBe(before + 1);

    const cacheFile = getComponentMatrixCacheFilePath(basePath, gamePath);
    expect(existsSync(cacheFile)).toBe(true);

    invalidateComponentMatrixCache();
    PakVirtualFS.invalidate();

    await callComponentSearch(config, { entityType: "GenericEntity" });
    const afterSecond = __getMatrixBuildCountForTest();

    expect(afterSecond).toBe(after); // no rebuild — served from persisted cache
  });

  it("rebuilds gracefully when the persisted cache is corrupt", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "W1.et"), WEAPON_ET);

    const config = makeConfig(gamePath);
    await callComponentSearch(config, { entityType: "GenericEntity" });
    const cacheFile = getComponentMatrixCacheFilePath(basePath, gamePath);
    expect(existsSync(cacheFile)).toBe(true);
    writeFileSync(cacheFile, "{ not valid json ][");

    invalidateComponentMatrixCache();
    PakVirtualFS.invalidate();

    const before = __getMatrixBuildCountForTest();
    const result = await callComponentSearch(config, { entityType: "GenericEntity" });
    const after = __getMatrixBuildCountForTest();

    expect(after).toBe(before + 1);
    expect(result.isError).toBeFalsy();
    expect(getText(result)).toContain("MeshObject");
  });

  it("invalidates the persisted cache when a .et file is added", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "W1.et"), WEAPON_ET);

    const config = makeConfig(gamePath);
    const before = __getMatrixBuildCountForTest();
    await callComponentSearch(config, { entityType: "GenericEntity" });
    const afterFirst = __getMatrixBuildCountForTest();
    expect(afterFirst).toBe(before + 1);

    invalidateComponentMatrixCache();
    PakVirtualFS.invalidate();

    writeFileSync(join(basePath, "Prefabs", "W2.et"), WEAPON_ET_2);

    await callComponentSearch(config, { entityType: "GenericEntity" });
    const afterSecond = __getMatrixBuildCountForTest();

    expect(afterSecond).toBe(afterFirst + 1);
  });

  it("refresh:true forces a full rebuild even when the persisted cache is valid", async () => {
    const { gamePath, basePath } = makeGameDirs();
    mkdirSync(join(basePath, "Prefabs"), { recursive: true });
    writeFileSync(join(basePath, "Prefabs", "W1.et"), WEAPON_ET);

    const config = makeConfig(gamePath);
    await callComponentSearch(config, { entityType: "GenericEntity" });
    const afterFirst = __getMatrixBuildCountForTest();

    await callComponentSearch(config, { entityType: "GenericEntity", refresh: true });
    const afterRefresh = __getMatrixBuildCountForTest();

    expect(afterRefresh).toBe(afterFirst + 1);
  });
});

describe("component matrix cache schema validation", () => {
  it("rejects a persisted cache whose looseFingerprint values are not numbers", () => {
    const { gamePath, basePath } = makeGameDirs();

    // Write a structurally-valid but semantically-corrupt cache: looseFingerprint
    // values must be numbers (mtimes), but this one has a string.
    savePersistedComponentMatrix({
      basePath,
      gamePath,
      looseFingerprint: { "some/file.et": "not-a-number" as unknown as number },
      pakFingerprints: [],
      matrix: {},
    });

    const loaded = loadPersistedComponentMatrix(basePath, gamePath);
    expect(loaded).toBeNull();
  });

  it("accepts a persisted cache whose looseFingerprint values are all numbers", () => {
    const { gamePath, basePath } = makeGameDirs();

    savePersistedComponentMatrix({
      basePath,
      gamePath,
      looseFingerprint: { "some/file.et": 12345 },
      pakFingerprints: [],
      matrix: {},
    });

    const loaded = loadPersistedComponentMatrix(basePath, gamePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.looseFingerprint).toEqual({ "some/file.et": 12345 });
  });
});
