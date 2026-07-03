import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "../../src/index/search-engine.js";
import { checkScript } from "../../src/tools/script-check.js";
import type { ClassInfo, GroupInfo, WikiPage } from "../../src/index/types.js";

/**
 * Build a small hand-crafted fixture data dir with a parent/child chain:
 *
 *   Managed (root)
 *     -> ChimeraGame     (declares GetPlayerManager, GetGameMode)
 *          -> SCR_BaseGameMode  (declares OnGameStart; no GetPlayerManager of its own)
 *
 * This mirrors the real Faza-2 bug: calling SCR_BaseGameMode.GetPlayerManager()
 * when the method actually lives on the parent ChimeraGame class.
 */
function makeClass(overrides: Partial<ClassInfo> & { name: string }): ClassInfo {
  return {
    name: overrides.name,
    source: "enfusion",
    brief: "",
    description: "",
    parents: [],
    children: [],
    group: "Test",
    sourceFile: "",
    methods: [],
    protectedMethods: [],
    staticMethods: [],
    enums: [],
    properties: [],
    protectedProperties: [],
    docsUrl: "",
    ...overrides,
  };
}

function buildFixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "script-check-fixture-"));
  const apiDir = join(dir, "api");
  const wikiDir = join(dir, "wiki");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });

  const managed = makeClass({
    name: "Managed",
    parents: [],
    children: ["ChimeraGame"],
  });

  const chimeraGame = makeClass({
    name: "ChimeraGame",
    parents: ["Managed"],
    children: ["SCR_BaseGameMode"],
    methods: [
      {
        name: "GetPlayerManager",
        returnType: "PlayerManager",
        signature: "PlayerManager GetPlayerManager()",
        params: [],
        description: "Returns the player manager instance.",
      },
      {
        name: "GetGameMode",
        returnType: "SCR_BaseGameMode",
        signature: "SCR_BaseGameMode GetGameMode()",
        params: [],
        description: "Returns the active game mode.",
      },
    ],
  });

  const baseGameMode = makeClass({
    name: "SCR_BaseGameMode",
    parents: ["ChimeraGame"],
    children: [],
    methods: [
      {
        name: "OnGameStart",
        returnType: "void",
        signature: "void OnGameStart()",
        params: [],
        description: "Called when the game starts.",
      },
    ],
  });

  const enfusionClasses: ClassInfo[] = [managed, chimeraGame, baseGameMode];
  const armaClasses: ClassInfo[] = [];
  const groups: GroupInfo[] = [];
  const wikiPages: WikiPage[] = [
    { title: "Placeholder", source: "enfusion", content: "placeholder wiki content" },
  ];

  writeFileSync(join(apiDir, "enfusion-classes.json"), JSON.stringify(enfusionClasses));
  writeFileSync(join(apiDir, "arma-classes.json"), JSON.stringify(armaClasses));
  writeFileSync(join(apiDir, "groups.json"), JSON.stringify(groups));
  writeFileSync(join(wikiDir, "pages.json"), JSON.stringify(wikiPages));

  return dir;
}

describe("script_check", () => {
  let dataDir: string;
  let engine: SearchEngine;

  beforeAll(() => {
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("confirms an exact own method with its signature", () => {
    const result = checkScript(engine, "ChimeraGame", "GetGameMode");
    expect(result.found).toBe(true);
    expect(result.declaringClass).toBe("ChimeraGame");
    expect(result.signature).toBe("SCR_BaseGameMode GetGameMode()");
  });

  it("suggests the closest method name for a typo", () => {
    const result = checkScript(engine, "ChimeraGame", "GetPlayerManagr");
    expect(result.found).toBe(false);
    expect(result.classExists).toBe(true);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].name).toBe("GetPlayerManager");
  });

  it("finds a method defined on a parent class and names the declaring class (Faza-2 regression)", () => {
    const result = checkScript(engine, "SCR_BaseGameMode", "GetPlayerManager");
    expect(result.found).toBe(true);
    expect(result.declaringClass).toBe("ChimeraGame");
    expect(result.declaringClass).not.toBe("SCR_BaseGameMode");
    expect(result.signature).toBe("PlayerManager GetPlayerManager()");
    expect(result.inherited).toBe(true);
  });

  it("reports a clear not-found message with suggestions for an unknown method on a real class", () => {
    const result = checkScript(engine, "SCR_BaseGameMode", "GetPlayerManage");
    expect(result.found).toBe(false);
    expect(result.classExists).toBe(true);
    expect(result.message).toMatch(/not found/i);
    expect(result.suggestions.length).toBeGreaterThan(0);
  });

  it("reports a clear class-not-found message for an unknown class", () => {
    const result = checkScript(engine, "SCR_BaseGamMode", "GetPlayerManager");
    expect(result.found).toBe(false);
    expect(result.classExists).toBe(false);
    expect(result.message).toMatch(/class.*not found/i);
    // fuzzy class-name suggestions should point at the real class
    expect(result.classSuggestions).toBeDefined();
    expect(result.classSuggestions!.length).toBeGreaterThan(0);
    expect(result.classSuggestions![0]).toBe("SCR_BaseGameMode");
  });

  it("tolerates a fuller pasted signature and extracts the bare method name", () => {
    const result = checkScript(engine, "ChimeraGame", "PlayerManager GetPlayerManager()");
    expect(result.found).toBe(true);
    expect(result.declaringClass).toBe("ChimeraGame");
  });
});
