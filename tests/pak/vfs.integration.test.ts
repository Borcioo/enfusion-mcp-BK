import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { PakVirtualFS } from "../../src/pak/vfs.js";

// This suite reads the real Arma Reforger base-game .pak archives from a
// local Steam install. It only runs when that directory is present (e.g.
// on the author's machine); everywhere else it is skipped at collection
// time, before any file is touched, mirroring the pattern used by
// tests/animation/integration-m151a2.test.ts.
//
// It exists as a regression test for the "invalid block type" bug: pak
// file entry offsets are ABSOLUTE byte positions within the .pak file (not
// relative to the DATA chunk payload), and compressed entries are
// zlib-wrapped deflate streams (not raw/headerless deflate). Getting either
// of those wrong corrupts nearly every compressed read and silently
// truncates every uncompressed read — see src/pak/vfs.ts readFile().
const GAME_PATH = process.env.ENFUSION_GAME_PATH ?? "E:/Steam/steamapps/common/Arma Reforger";

describe("PakVirtualFS real game data (author-machine-only)", () => {
  if (!existsSync(`${GAME_PATH}/addons`)) {
    it.skip("skipped: base game addons/ directory not found on this machine", () => {});
    return;
  }

  const vfs = PakVirtualFS.get(GAME_PATH);

  it("initializes the VFS from real .pak files", () => {
    expect(vfs).not.toBeNull();
    expect(vfs!.fileCount).toBeGreaterThan(1000);
  });

  it("reads a previously-failing compressed generated script (regression for #invalid-block-type)", () => {
    const path =
      "scripts/Game/generated/Plugins/Persistence/System/Serializers/ScriptedComponentSerializer.c";
    expect(vfs!.exists(path)).toBe(true);
    const content = vfs!.readTextFile(path);
    expect(content).toContain("class ScriptedComponentSerializer");
  });

  it("reads a sibling uncompressed generated script fully (not truncated)", () => {
    const path = "scripts/Game/generated/Systems/Persistence/Serializers/DoorComponentSerializer.c";
    expect(vfs!.exists(path)).toBe(true);
    const content = vfs!.readTextFile(path);
    // Prior to the fix, reads started `dataStart` bytes too late, silently
    // truncating the leading file-header comment block.
    expect(content.startsWith("/*")).toBe(true);
    expect(content).toContain("class DoorComponentSerializer");
  });

  it("reads a broad sample of compressed and uncompressed entries without error", () => {
    const paths = vfs!.allFilePaths();
    // Deterministic sample across the whole archive set.
    const step = Math.max(1, Math.floor(paths.length / 500));
    let checked = 0;
    for (let i = 0; i < paths.length; i += step) {
      const buf = vfs!.readFile(paths[i]);
      expect(buf.length).toBe(vfs!.fileSize(paths[i]));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});
