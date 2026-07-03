import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "../../src/index/search-engine.js";
import { validateScriptReferences } from "../../src/utils/script-validate.js";
import type { ClassInfo, GroupInfo, WikiPage } from "../../src/index/types.js";

/**
 * Small hand-built fixture mirroring tests/tools/script-check.test.ts:
 *   ChimeraGame declares GetPlayerManager / GetGameMode.
 *   SCR_BaseGameMode extends ChimeraGame, declares OnGameStart only.
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
  const dir = mkdtempSync(join(tmpdir(), "script-validate-fixture-"));
  const apiDir = join(dir, "api");
  const wikiDir = join(dir, "wiki");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });

  const chimeraGame = makeClass({
    name: "ChimeraGame",
    parents: [],
    children: ["SCR_BaseGameMode"],
    methods: [
      {
        name: "GetPlayerManager",
        returnType: "PlayerManager",
        signature: "PlayerManager GetPlayerManager()",
        params: [],
        description: "Returns the player manager instance.",
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

  const enfusionClasses: ClassInfo[] = [chimeraGame, baseGameMode];
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

describe("validateScriptReferences", () => {
  let dataDir: string;
  let engine: SearchEngine;

  beforeAll(() => {
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("does not warn for a real indexed method call", () => {
    const content = `
      class MyGameMode : SCR_BaseGameMode {
        void Foo() {
          ChimeraGame game;
          game.GetPlayerManager();
          ChimeraGame.GetPlayerManager();
        }
      }
    `;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings).toEqual([]);
  });

  it("warns with a did-you-mean suggestion for a hallucinated method on a known class", () => {
    const content = `
      class MyGameMode : SCR_BaseGameMode {
        void Foo() {
          ChimeraGame.GetPlayerManagr();
        }
      }
    `;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("ChimeraGame.GetPlayerManagr");
    expect(warnings[0].toLowerCase()).toContain("did you mean");
    expect(warnings[0]).toContain("GetPlayerManager");
  });

  it("does not flag a class declared locally in the same file, even for a hallucinated-looking call", () => {
    // MyLocalClass isn't in the API index at all, so it's excluded via the
    // index-membership gate. This is the common case for mod-local classes.
    const content = `
      class MyLocalClass {
        void DoSomething() {}
      }
      class Caller {
        void Foo() {
          MyLocalClass.DoSomethingElse();
        }
      }
    `;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings).toEqual([]);
  });

  it("does not flag a locally-modded class that reuses an indexed class name to add a new method", () => {
    // The file re-declares (modded class) SCR_BaseGameMode, which IS indexed —
    // without the local-declaration exclusion this would false-positive.
    const content = `
      modded class SCR_BaseGameMode {
        void OnMissionStart() {
          SCR_BaseGameMode.OnMissionStart();
        }
      }
    `;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings).toEqual([]);
  });

  it("does not flag built-in idioms: Print, string.Format, Math.*, casts, super", () => {
    const content = `
      class Foo {
        void Bar() {
          Print("hello");
          string s = string.Format("%1", 5);
          float m = Math.Max(1, 2);
          SCR_BaseGameMode game = SCR_BaseGameMode.Cast(GetGame());
          super.Bar();
        }
      }
    `;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings).toEqual([]);
  });

  it("caps the number of warnings returned", () => {
    const calls = Array.from(
      { length: 20 },
      (_, i) => `ChimeraGame.Bogus${i}();`
    ).join("\n");
    const content = `class Foo { void Bar() { ${calls} } }`;
    const warnings = validateScriptReferences(engine, content);
    expect(warnings.length).toBeLessThanOrEqual(5);
  });
});
