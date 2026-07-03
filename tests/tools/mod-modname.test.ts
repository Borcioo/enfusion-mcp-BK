import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { PatternLibrary } from "../../src/patterns/loader.js";
import { registerMod } from "../../src/tools/mod.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-mod-modname");
const searchEngine = new SearchEngine(dataDir);

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

function write(relPath: string, content = ""): void {
  const fullPath = join(TEST_DIR, relPath);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    dataDir,
    patternsDir: resolve(dataDir, "patterns"),
    projectPath: TEST_DIR,
    // Isolate tests from this repo's own local dev config (enfusion-mcp.config.json
    // sets a real defaultMod for the maintainer's own workspace).
    defaultMod: undefined,
    ...overrides,
  };
}

function goodGproj(): string {
  return `GameProject {
 ID "TestMod"
 GUID "AAAAAAAAAAAAAAAA"
 Dependencies {
  "58D0FB3206B6F859"
 }
}`;
}

describe("mod validate modName support", () => {
  it("validate with modName scopes into the named addon", async () => {
    write("Central-Economy/source/addon.gproj", goodGproj());
    write("OtherMod/OtherMod.gproj", "not even valid content");

    const { server, handlers } = makeFakeServer();
    const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
    registerMod(server, makeConfig(), searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({ action: "validate", modName: "Central-Economy" });
    const text = getText(result);

    expect(text).toContain("Central-Economy");
    // Central-Economy's gproj is valid, OtherMod's is not — scoping must only see Central-Economy.
    expect(text).not.toContain("not even valid");
  });

  it("unknown modName returns a clear error", async () => {
    write("OtherMod/OtherMod.gproj", goodGproj());

    const { server, handlers } = makeFakeServer();
    const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
    registerMod(server, makeConfig(), searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({ action: "validate", modName: "NoSuchMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("NoSuchMod");
  });

  it("regression: validate without modName on a legacy single-addon projectPath behaves as before", async () => {
    write("SingleMod.gproj", goodGproj());
    write("Scripts/Game/SM_Test.c", "class SM_Test : ScriptComponent {}");

    const { server, handlers } = makeFakeServer();
    const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
    registerMod(server, makeConfig(), searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({ action: "validate" });
    const text = getText(result);
    expect(text).toContain("Validation Report");
    expect(result.isError).toBeUndefined();
  });

  it("regression: validate without modName + defaultMod configured falls back to configured projectPath (old behavior)", async () => {
    write("SingleMod.gproj", goodGproj());

    const { server, handlers } = makeFakeServer();
    const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
    // defaultMod does not exist as a subdirectory (legacy single-addon layout) —
    // resolution must fall back to projectPath itself, exactly as before this feature.
    registerMod(server, makeConfig({ defaultMod: "SingleMod" }), searchEngine, patterns);
    const mod = handlers.get("mod")!;

    const result = await mod({ action: "validate" });
    const text = getText(result);
    expect(text).toContain("Validation Report");
    expect(result.isError).toBeUndefined();
  });
});
