import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveAddonDir, findGproj, listAddons } from "../../src/utils/game-paths.js";

const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-game-paths");

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

describe("findGproj", () => {
  it("finds a .gproj directly in the directory", () => {
    write("MyMod/MyMod.gproj", "GameProject {}");
    const found = findGproj(join(TEST_DIR, "MyMod"));
    expect(found).toBe(join(TEST_DIR, "MyMod", "MyMod.gproj"));
  });

  it("finds a .gproj nested one level down (Central-Economy/source layout)", () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    const found = findGproj(join(TEST_DIR, "Central-Economy"));
    expect(found).toBe(join(TEST_DIR, "Central-Economy", "source", "addon.gproj"));
  });

  it("returns null when no .gproj exists anywhere nearby", () => {
    write("EmptyMod/README.txt", "hi");
    const found = findGproj(join(TEST_DIR, "EmptyMod"));
    expect(found).toBeNull();
  });
});

describe("resolveAddonDir", () => {
  it("resolves an explicit modName to its addon folder", () => {
    write("ModA/ModA.gproj", "GameProject {}");
    write("ModB/ModB.gproj", "GameProject {}");
    const dir = resolveAddonDir(TEST_DIR, "ModB");
    expect(dir).toBe(resolve(TEST_DIR, "ModB"));
  });

  it("resolves a modName whose .gproj lives in a nested source/ subdir", () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    const dir = resolveAddonDir(TEST_DIR, "Central-Economy");
    expect(dir).toBe(resolve(TEST_DIR, "Central-Economy"));
  });

  it("returns null when modName does not exist under the workspace", () => {
    write("ModA/ModA.gproj", "GameProject {}");
    const dir = resolveAddonDir(TEST_DIR, "DoesNotExist");
    expect(dir).toBeNull();
  });

  it("rejects path traversal via modName", () => {
    write("ModA/ModA.gproj", "GameProject {}");
    const dir = resolveAddonDir(TEST_DIR, "../outside");
    expect(dir).toBeNull();
  });

  it("auto-detects the first addon with a .gproj when modName is omitted", () => {
    write("ModA/ModA.gproj", "GameProject {}");
    const dir = resolveAddonDir(TEST_DIR);
    expect(dir).toBe(resolve(TEST_DIR, "ModA"));
  });
});

describe("listAddons", () => {
  it("lists addon folders and flags which ones contain a .gproj", () => {
    write("Central-Economy/source/addon.gproj", "GameProject {}");
    write("OtherMod/OtherMod.gproj", "GameProject {}");
    write("NotAnAddon/README.txt", "hi");

    const addons = listAddons(TEST_DIR);
    const names = addons.map((a) => a.name).sort();
    expect(names).toEqual(["Central-Economy", "NotAnAddon", "OtherMod"]);

    const ce = addons.find((a) => a.name === "Central-Economy")!;
    expect(ce.hasGproj).toBe(true);
    expect(ce.gprojPath).toBe(join(TEST_DIR, "Central-Economy", "source", "addon.gproj"));

    const notAddon = addons.find((a) => a.name === "NotAnAddon")!;
    expect(notAddon.hasGproj).toBe(false);
    expect(notAddon.gprojPath).toBeNull();
  });

  it("returns an empty array for a workspace with no subdirectories", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const addons = listAddons(TEST_DIR);
    expect(addons).toEqual([]);
  });
});
