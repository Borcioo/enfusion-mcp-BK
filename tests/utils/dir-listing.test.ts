import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FILE_TYPE_MAP,
  getFileType,
  formatSize,
  listDirectory,
} from "../../src/utils/dir-listing.js";

describe("formatSize", () => {
  it("formats bytes under 1024 as B", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1023)).toBe("1023 B");
  });

  it("formats bytes >= 1024 and < 1MB as KB", () => {
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("formats bytes >= 1MB as MB", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1024 * 1024 * 2.5)).toBe("2.5 MB");
  });
});

describe("FILE_TYPE_MAP", () => {
  it("contains the union of extensions from game-browse and project", () => {
    expect(FILE_TYPE_MAP[".c"]).toBe("script");
    expect(FILE_TYPE_MAP[".et"]).toBe("prefab");
    expect(FILE_TYPE_MAP[".conf"]).toBe("config");
    expect(FILE_TYPE_MAP[".layout"]).toBe("ui-layout");
    expect(FILE_TYPE_MAP[".emat"]).toBe("material");
    expect(FILE_TYPE_MAP[".sounds"]).toBe("sound");
  });
});

describe("getFileType", () => {
  it("maps known extensions to labels", () => {
    expect(getFileType("Foo.c")).toBe("script");
    expect(getFileType("Bar.emat")).toBe("material");
    expect(getFileType("Baz.sounds")).toBe("sound");
  });

  it("returns empty string for unknown extensions", () => {
    expect(getFileType("Foo.unknown")).toBe("");
  });
});

describe("listDirectory", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dir-listing-test-"));
    mkdirSync(join(dir, "ZDir"));
    mkdirSync(join(dir, "ADir"));
    writeFileSync(join(dir, "script.c"), "class Foo {}");
    writeFileSync(join(dir, "material.emat"), "1234567890");
    writeFileSync(join(dir, ".hidden"), "should be skipped");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists directories before files, alphabetically within each group", () => {
    const entries = listDirectory(dir);
    const names = entries.map((e) => e.name);
    expect(names).toEqual(["ADir", "ZDir", "material.emat", "script.c"]);
  });

  it("marks directories with isDirectory true and size 0", () => {
    const entries = listDirectory(dir);
    const aDir = entries.find((e) => e.name === "ADir")!;
    expect(aDir.isDirectory).toBe(true);
    expect(aDir.size).toBe(0);
    expect(aDir.type).toBe("");
  });

  it("marks files with correct isDirectory, size, and type", () => {
    const entries = listDirectory(dir);
    const scriptFile = entries.find((e) => e.name === "script.c")!;
    expect(scriptFile.isDirectory).toBe(false);
    expect(scriptFile.size).toBe("class Foo {}".length);
    expect(scriptFile.type).toBe("script");

    const matFile = entries.find((e) => e.name === "material.emat")!;
    expect(matFile.type).toBe("material");
  });

  it("skips dotfiles", () => {
    const entries = listDirectory(dir);
    expect(entries.find((e) => e.name === ".hidden")).toBeUndefined();
  });

  it("filters by pattern when provided", () => {
    const entries = listDirectory(dir, "*.c");
    expect(entries.map((e) => e.name)).toEqual(["ADir", "ZDir", "script.c"]);
  });
});
