import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { PatternLibrary } from "../../src/patterns/loader.js";
import { registerMod, buildPublishArgs } from "../../src/tools/mod.js";

const dataDir = resolve(import.meta.dirname, "../../data");
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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    dataDir,
    patternsDir: resolve(dataDir, "patterns"),
    // Point at a Workbench path that definitely does not contain the exe, so
    // any test that reaches the exe-resolution step gets a deterministic
    // "not found" error instead of possibly finding a real install.
    workbenchPath: resolve(import.meta.dirname, "../../tmp-test-mod-publish-no-workbench"),
    defaultMod: undefined,
    ...overrides,
  };
}

async function getPublishHandler() {
  const { server, handlers } = makeFakeServer();
  const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
  registerMod(server, makeConfig(), searchEngine, patterns);
  return handlers.get("mod")!;
}

describe("buildPublishArgs (pure CLI argv construction)", () => {
  it("pack-only, no options: base ResourceManager pack invocation", () => {
    const args = buildPublishArgs({});
    expect(args).toEqual(["-wbModule=ResourceManager", "-packAddon"]);
  });

  it("includes -packAddonDir when packDir given", () => {
    const args = buildPublishArgs({ packDir: "D:\\build\\Green" });
    expect(args).toEqual(["-wbModule=ResourceManager", "-packAddon", "-packAddonDir", "D:\\build\\Green"]);
  });

  it("includes -gproj when gprojPath given", () => {
    const args = buildPublishArgs({ gprojPath: "C:\\mods\\MyMod\\MyMod.gproj" });
    expect(args).toEqual([
      "-wbModule=ResourceManager",
      "-packAddon",
      "-gproj",
      "C:\\mods\\MyMod\\MyMod.gproj",
    ]);
  });

  it("does NOT include -publishAddon or any publish-* flags when confirmPublish is falsy", () => {
    const args = buildPublishArgs({
      packDir: "D:\\build\\Green",
      version: "1.2.0",
      changeNote: "Fix shading",
      previewImage: "z:/mymod/preview.jpg",
      screenshotsDir: "Z:/mymod/screenshots",
      confirmPublish: false,
    });
    expect(args.join(" ")).not.toContain("-publishAddon");
    expect(args).toEqual(["-wbModule=ResourceManager", "-packAddon", "-packAddonDir", "D:\\build\\Green"]);
  });

  it("includes -publishAddon and -publishAddonDir (same as packDir) when confirmPublish is true", () => {
    const args = buildPublishArgs({ packDir: "D:\\build\\Green", confirmPublish: true });
    expect(args).toEqual([
      "-wbModule=ResourceManager",
      "-packAddon",
      "-packAddonDir",
      "D:\\build\\Green",
      "-publishAddon",
      "-publishAddonDir",
      "D:\\build\\Green",
    ]);
  });

  it("maps all optional publish metadata to their documented CLI flags when confirmPublish is true", () => {
    const args = buildPublishArgs({
      packDir: "D:\\build\\Green",
      version: "2.3.5",
      changeNote: "Fix shading",
      changeNoteFile: "C:\\Addon\\changelog.txt",
      previewImage: "z:/mymod/my_preview_image.jpg",
      screenshotsDir: "Z:/mymod/screenshots",
      confirmPublish: true,
    });

    expect(args).toEqual([
      "-wbModule=ResourceManager",
      "-packAddon",
      "-packAddonDir",
      "D:\\build\\Green",
      "-publishAddon",
      "-publishAddonDir",
      "D:\\build\\Green",
      "-publishAddonVersion",
      "2.3.5",
      "-publishAddonChangeNote",
      "Fix shading",
      "-publishAddonChangeNoteFile",
      "C:\\Addon\\changelog.txt",
      "-publishAddonPreviewImage",
      "z:/mymod/my_preview_image.jpg",
      "-publishAddonScreenshots",
      "Z:/mymod/screenshots",
    ]);
  });

  it("omits publish-metadata flags entirely when their values are omitted, even with confirmPublish true", () => {
    const args = buildPublishArgs({ confirmPublish: true });
    expect(args).toEqual(["-wbModule=ResourceManager", "-packAddon", "-publishAddon"]);
  });
});

describe("mod action=publish (handler-level gating)", () => {
  it("missing addonName returns a clear error", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("addonName");
  });

  it("dryRun=true returns the command preview and does not execute anything (no exe-not-found error)", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", dryRun: true });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("-wbModule=ResourceManager");
    expect(text).toContain("-packAddon");
    // Must not attempt to resolve/execute the real exe.
    expect(text).not.toContain("Workbench not found");
  });

  it("confirmPublish omitted (default false): reports NOT PUBLISHED without touching the exe", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod" });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("NOT PUBLISHED");
    expect(text).not.toContain("Workbench not found");
  });

  it("always documents the manual first-time-publish GUI requirement", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod" });
    const text = getText(result);
    expect(text).toContain("Publish Project");
    expect(text.toLowerCase()).toContain("manual");
  });

  it("confirmPublish=true but Workbench exe not found: clear error, no crash", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", confirmPublish: true });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Workbench not found");
  });
});
