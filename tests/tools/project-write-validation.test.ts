import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { registerProject } from "../../src/tools/project.js";
import { registerProjectPatch } from "../../src/tools/project-patch.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import type { ClassInfo, GroupInfo, WikiPage } from "../../src/index/types.js";

const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-project-write-validation");

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
  const dir = mkdtempSync(join(tmpdir(), "project-write-validate-fixture-"));
  const apiDir = join(dir, "api");
  const wikiDir = join(dir, "wiki");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });

  const chimeraGame = makeClass({
    name: "ChimeraGame",
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

  writeFileSync(join(apiDir, "enfusion-classes.json"), JSON.stringify([chimeraGame, baseGameMode]));
  writeFileSync(join(apiDir, "arma-classes.json"), JSON.stringify([]));
  writeFileSync(join(apiDir, "groups.json"), JSON.stringify([] as GroupInfo[]));
  writeFileSync(
    join(wikiDir, "pages.json"),
    JSON.stringify([{ title: "Placeholder", source: "enfusion", content: "placeholder" }] as WikiPage[])
  );

  return dir;
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    dataDir: resolve(import.meta.dirname, "../../data"),
    patternsDir: resolve(import.meta.dirname, "../../data/patterns"),
    projectPath: TEST_DIR,
    defaultMod: undefined,
    ...overrides,
  };
}

describe("project write action with cross-reference validation", () => {
  let dataDir: string;
  let engine: SearchEngine;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("writes a script calling a real indexed method with no warning", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig(), engine);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Scripts/Game/Foo.c",
      content: "class Foo { void Bar() { ChimeraGame.GetPlayerManager(); } }",
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result).toLowerCase()).not.toContain("warning");
    expect(existsSync(join(TEST_DIR, "Scripts/Game/Foo.c"))).toBe(true);
  });

  it("writes a script with a hallucinated method and still writes the file, with an inline warning", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig(), engine);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Scripts/Game/Bad.c",
      content: "class Foo { void Bar() { SCR_BaseGameMode.NonexistentMethod(); } }",
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.toLowerCase()).toContain("warning");
    expect(text).toContain("NonexistentMethod");
    // The write still happened despite the warning.
    expect(existsSync(join(TEST_DIR, "Scripts/Game/Bad.c"))).toBe(true);
    expect(readFileSync(join(TEST_DIR, "Scripts/Game/Bad.c"), "utf-8")).toContain("NonexistentMethod");
  });

  it("does not flag a locally-modded class in the same file (no false positive)", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig(), engine);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Scripts/Game/Modded.c",
      content: "modded class SCR_BaseGameMode { void MyCustomHook() { SCR_BaseGameMode.MyCustomHook(); } }",
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result).toLowerCase()).not.toContain("warning");
  });

  it("skips validation for non-.c files even when searchEngine is provided", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig(), engine);
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "config.json",
      content: "SCR_BaseGameMode.NonexistentMethod()",
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result).toLowerCase()).not.toContain("warning");
  });

  it("still works when no searchEngine is passed (backward compatible)", async () => {
    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Scripts/Game/NoEngine.c",
      content: "class Foo { void Bar() { SCR_BaseGameMode.NonexistentMethod(); } }",
    });

    expect(result.isError).toBeFalsy();
    expect(existsSync(join(TEST_DIR, "Scripts/Game/NoEngine.c"))).toBe(true);
  });
});

describe("project_patch with cross-reference validation", () => {
  let dataDir: string;
  let engine: SearchEngine;

  beforeEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
  });

  afterAll(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("patches a script that introduces a hallucinated call and warns, but still writes", async () => {
    const filePath = join(TEST_DIR, "Scripts/Game/Patched.c");
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(filePath, "class Foo { void Bar() { /*TODO*/ } }", "utf-8");

    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, makeConfig(), engine);
    const patch = handlers.get("project_patch")!;

    const result = await patch({
      path: "Scripts/Game/Patched.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "/*TODO*/", newString: "SCR_BaseGameMode.NonexistentMethod();" }],
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text.toLowerCase()).toContain("warning");
    expect(readFileSync(filePath, "utf-8")).toContain("NonexistentMethod");
  });

  it("patches with a real method call and no warning", async () => {
    const filePath = join(TEST_DIR, "Scripts/Game/Patched2.c");
    mkdirSync(resolve(filePath, ".."), { recursive: true });
    writeFileSync(filePath, "class Foo { void Bar() { /*TODO*/ } }", "utf-8");

    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, makeConfig(), engine);
    const patch = handlers.get("project_patch")!;

    const result = await patch({
      path: "Scripts/Game/Patched2.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "/*TODO*/", newString: "ChimeraGame.GetPlayerManager();" }],
    });

    expect(result.isError).toBeFalsy();
    expect(getText(result).toLowerCase()).not.toContain("warning");
  });
});
