import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { registerProject } from "../../src/tools/project.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-project-modname");

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

describe("project modName support", () => {
  it("browse at workspace root with no modName lists the addon folders", async () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("OtherMod/OtherMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({ action: "browse" });
    const text = getText(result);

    expect(text).toContain("Central-Economy");
    expect(text).toContain("OtherMod");
    expect(text.toLowerCase()).toContain("addon");
  });

  it("browse with modName enters that addon", async () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("Central-Economy/Scripts/Game/CE_Test.c", "class CE_Test {}");
    write("OtherMod/OtherMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({ action: "browse", modName: "Central-Economy" });
    const text = getText(result);

    expect(text).toContain("Scripts");
    expect(text).not.toContain("OtherMod");
  });

  it("write with modName routes the file into the correct addon", async () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("OtherMod/OtherMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      modName: "OtherMod",
      path: "Scripts/Game/OM_Test.c",
      content: "class OM_Test {}",
    });

    expect(result.isError).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "OtherMod", "Scripts", "Game", "OM_Test.c"))).toBe(true);
    expect(existsSync(join(TEST_DIR, "Central-Economy", "Scripts", "Game", "OM_Test.c"))).toBe(false);
    expect(readFileSync(join(TEST_DIR, "OtherMod", "Scripts", "Game", "OM_Test.c"), "utf-8")).toBe(
      "class OM_Test {}"
    );
  });

  it("read with modName reads from the correct addon", async () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("Central-Economy/Scripts/Game/CE_Test.c", "class CE_Test {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({
      action: "read",
      modName: "Central-Economy",
      path: "Scripts/Game/CE_Test.c",
    });

    expect(getText(result)).toBe("class CE_Test {}");
  });

  it("unknown modName returns a clear error", async () => {
    write("OtherMod/OtherMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({ action: "browse", modName: "NoSuchMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("NoSuchMod");
  });

  it("regression: single-addon project (no subdirs) browses exactly as before without modName", async () => {
    write("SingleMod.gproj", "GameProject {}");
    write("Scripts/Game/SM_Test.c", "class SM_Test {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({ action: "browse" });
    const text = getText(result);

    // Old behavior: lists the project root's own contents directly, not an addon list.
    expect(text).toContain("SingleMod.gproj");
    expect(text).toContain("Scripts");
    expect(text).not.toContain("Addons found");
  });

  it("regression: write without modName still writes directly under projectPath as before", async () => {
    write("SingleMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig());
    const project = handlers.get("project")!;

    const result = await project({
      action: "write",
      path: "Scripts/Game/SM_New.c",
      content: "class SM_New {}",
    });

    expect(result.isError).toBeUndefined();
    expect(existsSync(join(TEST_DIR, "Scripts", "Game", "SM_New.c"))).toBe(true);
  });

  it("defaultMod set to a nested-source addon (Central-Economy layout): root browse enters the addon, not the addon list", async () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("Central-Economy/source/Scripts/Game/CE_Test.c", "class CE_Test {}");
    write("OtherMod/OtherMod.gproj", "GameProject {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig({ defaultMod: "Central-Economy" }));
    const project = handlers.get("project")!;

    const result = await project({ action: "browse" });
    const text = getText(result);

    // Should browse INTO the resolved Central-Economy addon (contains "source"),
    // not fall back to listing the workspace's addon folders.
    expect(text).toContain("source");
    expect(text).not.toContain("Addons found");
    expect(text).not.toContain("OtherMod");
  });

  it("regression: no modName + defaultMod configured preserves old projectPath-based behavior", async () => {
    write("SingleMod.gproj", "GameProject {}");
    write("Scripts/Game/SM_Test.c", "class SM_Test {}");

    const { server, handlers } = makeFakeServer();
    registerProject(server, makeConfig({ defaultMod: "SingleMod" }));
    const project = handlers.get("project")!;

    // defaultMod does not exist as a subdir here (legacy single-mod layout),
    // so resolution must fall back to the configured projectPath itself.
    const result = await project({ action: "browse" });
    const text = getText(result);
    expect(text).toContain("SingleMod.gproj");
  });
});
