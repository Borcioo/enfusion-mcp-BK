import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { PatternLibrary } from "../../src/patterns/loader.js";

import { registerMod } from "../../src/tools/mod.js";
import { registerScriptCreate } from "../../src/tools/script-create.js";
import { registerPrefab } from "../../src/tools/prefab.js";
import { registerConfigCreate } from "../../src/tools/config-create.js";
import { registerLayoutCreate } from "../../src/tools/layout-create.js";
import { registerProject } from "../../src/tools/project.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-dry-run");

const config: Config = { ...loadConfig(), dataDir, patternsDir: resolve(dataDir, "patterns") };
const searchEngine = new SearchEngine(dataDir);
const patterns = new PatternLibrary(config.patternsDir);

type Handler = (args: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

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

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("dryRun on file-creating tools", () => {
  it("mod (action=create) previews the addon scaffold without writing anything", async () => {
    const { server, handlers } = makeFakeServer();
    registerMod(server, config, searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({
      action: "create",
      name: "DryMod",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("DryMod.gproj");
    expect(existsSync(join(TEST_DIR, "DryMod"))).toBe(false);
  });

  it("mod (action=create, dryRun omitted) still writes the addon to disk", async () => {
    const { server, handlers } = makeFakeServer();
    registerMod(server, config, searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({
      action: "create",
      name: "RealMod",
      projectPath: TEST_DIR,
    });

    const text = getText(result);
    expect(text).not.toContain("[dry-run]");
    expect(existsSync(join(TEST_DIR, "RealMod", "RealMod.gproj"))).toBe(true);
  });

  it("script_create previews the script file without writing it", async () => {
    const { server, handlers } = makeFakeServer();
    registerScriptCreate(server, config, searchEngine);
    const scriptCreate = handlers.get("script_create")!;

    const result = await scriptCreate({
      className: "DRY_TestComponent",
      scriptType: "component",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("DRY_TestComponent.c");
    expect(existsSync(join(TEST_DIR, "Scripts", "Game", "DRY_TestComponent.c"))).toBe(false);
  });

  it("prefab (action=create) previews the prefab file without writing it", async () => {
    const { server, handlers } = makeFakeServer();
    registerPrefab(server, config);
    const prefab = handlers.get("prefab")!;

    const result = await prefab({
      action: "create",
      name: "DryPrefab",
      prefabType: "generic",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("DryPrefab.et");
    expect(existsSync(join(TEST_DIR, "Prefabs", "DryPrefab.et"))).toBe(false);
  });

  it("config_create previews the config file without writing it", async () => {
    const { server, handlers } = makeFakeServer();
    registerConfigCreate(server, config);
    const configCreate = handlers.get("config_create")!;

    const result = await configCreate({
      configType: "faction",
      name: "DryFaction",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("DryFaction.conf");
    expect(existsSync(join(TEST_DIR, "Configs", "Factions", "DryFaction.conf"))).toBe(false);
  });

  it("layout_create previews the layout file without writing it", async () => {
    const { server, handlers } = makeFakeServer();
    registerLayoutCreate(server, config);
    const layoutCreate = handlers.get("layout_create")!;

    const result = await layoutCreate({
      name: "DryLayout",
      layoutType: "hud",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("DryLayout.layout");
    expect(existsSync(join(TEST_DIR, "UI", "layouts", "DryLayout.layout"))).toBe(false);
  });

  it("project (action=write) previews the file without writing it", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, config);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Notes/dry.txt",
      content: "hello dry-run",
      projectPath: TEST_DIR,
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("Notes/dry.txt");
    expect(existsSync(join(TEST_DIR, "Notes", "dry.txt"))).toBe(false);
  });

  it("project (action=write, dryRun omitted) still writes the file to disk", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, config);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Notes/real.txt",
      content: "hello real",
      projectPath: TEST_DIR,
    });

    const text = getText(result);
    expect(text).not.toContain("[dry-run]");
    expect(existsSync(join(TEST_DIR, "Notes", "real.txt"))).toBe(true);
  });
});
