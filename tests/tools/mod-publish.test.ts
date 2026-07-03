import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { PatternLibrary } from "../../src/patterns/loader.js";
import { registerMod, buildPublishArgs } from "../../src/tools/mod.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-mod-publish");
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
    // Multi-mod workspace used to resolve addonName -> .gproj.
    projectPath: TEST_DIR,
    // Point at a Workbench path that definitely does not contain the exe, so
    // any test that reaches the exe-resolution step gets a deterministic
    // "not found" error instead of possibly finding a real install.
    workbenchPath: resolve(import.meta.dirname, "../../tmp-test-mod-publish-no-workbench"),
    defaultMod: undefined,
    ...overrides,
  };
}

async function getPublishHandler(overrides: Partial<Config> = {}) {
  const { server, handlers } = makeFakeServer();
  const patterns = new PatternLibrary(resolve(dataDir, "patterns"));
  registerMod(server, makeConfig(overrides), searchEngine, patterns);
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

  // ── targeting resolution ──────────────────────────────────────────────

  it("unresolvable addonName (no such addon folder) returns a clear error BEFORE any spawn attempt", async () => {
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "NoSuchMod" });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain("NoSuchMod");
    // Must fail during resolution, never reach exe lookup.
    expect(text).not.toContain("Workbench not found");
  });

  it("addon folder exists but has no .gproj: clear error BEFORE any spawn attempt", async () => {
    write("EmptyMod/readme.txt", "no gproj here");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "EmptyMod" });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain("EmptyMod");
    expect(text).not.toContain("Workbench not found");
  });

  it("addonName resolves into a concrete -gproj in the argv (dryRun preview)", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", dryRun: true });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    const expectedGproj = join(TEST_DIR, "MyMod", "MyMod.gproj");
    expect(text).toContain("-gproj");
    expect(text).toContain(expectedGproj);
  });

  it("explicit gprojPath bypasses addonName folder resolution entirely", async () => {
    // addonName does not need to exist as a folder when gprojPath is explicit.
    const mod = await getPublishHandler();
    const result = await mod({
      action: "publish",
      addonName: "AnyName",
      gprojPath: "C:\\custom\\Explicit.gproj",
      dryRun: true,
    });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("-gproj");
    expect(text).toContain("C:\\custom\\Explicit.gproj");
  });

  // ── pack/publish decoupling ───────────────────────────────────────────

  it("confirmPublish omitted + resolvable target + non-dryRun: a real PACK run is attempted (no longer gated as 'NOT PUBLISHED')", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod" });
    // Workbench exe doesn't exist in the test environment, so a real spawn attempt
    // surfaces as "Workbench not found" — proof that packing was actually attempted
    // rather than short-circuited behind confirmPublish.
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain("Workbench not found");
    expect(text).not.toContain("NOT PUBLISHED");
    const commandLine = text.split("\n").find((l) => l.startsWith("**Command:**"))!;
    expect(commandLine).toContain("-packAddon");
    expect(commandLine).not.toContain("-publishAddon");
  });

  it("confirmPublish=true + resolvable target + non-dryRun: pack AND publish (-publishAddon) are both attempted", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", confirmPublish: true });
    expect(result.isError).toBe(true);
    const text = getText(result);
    expect(text).toContain("Workbench not found");
    const commandLine = text.split("\n").find((l) => l.startsWith("**Command:**"))!;
    expect(commandLine).toContain("-packAddon");
    expect(commandLine).toContain("-publishAddon");
    const expectedGproj = join(TEST_DIR, "MyMod", "MyMod.gproj");
    expect(commandLine).toContain(`-gproj ${expectedGproj}`);
  });

  it("dryRun=true still only previews the command and never touches the exe", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", dryRun: true });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("DRY RUN");
    expect(text).not.toContain("Workbench not found");
    const commandLine = text.split("\n").find((l) => l.startsWith("**Command:**"))!;
    expect(commandLine).toContain("-wbModule=ResourceManager");
    expect(commandLine).toContain("-packAddon");
    expect(commandLine).not.toContain("-publishAddon");
  });

  it("dryRun=true with confirmPublish=true previews the publish command too, still without executing", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", dryRun: true, confirmPublish: true });
    expect(result.isError).toBeUndefined();
    const text = getText(result);
    expect(text).toContain("DRY RUN");
    expect(text).toContain("-publishAddon");
    expect(text).not.toContain("Workbench not found");
  });

  it("always documents the manual first-time-publish GUI requirement", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", dryRun: true });
    const text = getText(result);
    expect(text).toContain("Publish Project");
    expect(text.toLowerCase()).toContain("manual");
  });

  it("confirmPublish=true but Workbench exe not found: clear error, no crash", async () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const mod = await getPublishHandler();
    const result = await mod({ action: "publish", addonName: "MyMod", confirmPublish: true });
    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Workbench not found");
  });
});
