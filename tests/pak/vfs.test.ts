import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateSync, deflateRawSync } from "node:zlib";
import { PakVirtualFS } from "../../src/pak/vfs.js";

/**
 * Build a minimal synthetic .pak file (same helper as reader.test.ts).
 *
 * IMPORTANT: real-world .pak files store each file entry's `offset` as an
 * ABSOLUTE byte position within the .pak file (baked in by the pak builder
 * at pack time), not an offset relative to the DATA chunk payload. This
 * fixture mirrors that: entry offsets are computed against the DATA
 * payload's absolute position in the final buffer (headLen is fixed below,
 * so that absolute base is known up front). Compressed entries use zlib-
 * wrapped deflate (deflateSync), matching PakVirtualFS.readFile's use of
 * inflateSync.
 */
function buildTestPak(files: Array<{ path: string; content: string; compress: boolean }>): Buffer {
  interface TreeFile { name: string; offset: number; compressedLen: number; decompressedLen: number; compressed: boolean }
  interface TreeDir { name: string; children: Map<string, TreeDir | TreeFile> }

  const headLen = 0x1c;
  // Absolute position where the DATA payload begins: FORM header (12) +
  // HEAD chunk header+payload (8 + headLen) + DATA chunk header (8).
  const dataPayloadAbsStart = 12 + 8 + headLen + 8;

  const dataChunks: Buffer[] = [];
  let dataOffset = 0;
  const root: TreeDir = { name: "", children: new Map() };

  for (const file of files) {
    const raw = Buffer.from(file.content, "utf-8");
    const stored = file.compress ? deflateSync(raw) : raw;

    const parts = file.path.split("/");
    const fileName = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let child = dir.children.get(part);
      if (!child || !("children" in child)) {
        child = { name: part, children: new Map() };
        dir.children.set(part, child);
      }
      dir = child as TreeDir;
    }

    dir.children.set(fileName, {
      name: fileName, offset: dataPayloadAbsStart + dataOffset,
      compressedLen: stored.length, decompressedLen: raw.length,
      compressed: file.compress,
    });
    dataChunks.push(stored);
    dataOffset += stored.length;
  }

  function serializeEntry(entry: TreeDir | TreeFile): Buffer {
    const nameBuf = Buffer.from(entry.name, "utf-8");
    const parts: Buffer[] = [];
    const header = Buffer.alloc(2);

    if ("children" in entry) {
      header.writeUInt8(0, 0);
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);
      const countBuf = Buffer.alloc(4);
      countBuf.writeUInt32LE(entry.children.size, 0);
      parts.push(countBuf);
      for (const child of entry.children.values()) {
        parts.push(serializeEntry(child));
      }
    } else {
      header.writeUInt8(1, 0);
      header.writeUInt8(nameBuf.length, 1);
      parts.push(header, nameBuf);
      const meta = Buffer.alloc(24);
      meta.writeUInt32LE(entry.offset, 0);
      meta.writeUInt32LE(entry.compressedLen, 4);
      meta.writeUInt32LE(entry.decompressedLen, 8);
      meta.writeUInt32LE(0, 12);
      meta.writeUInt16LE(0, 16);
      meta.writeUInt8(entry.compressed ? 1 : 0, 18);
      meta.writeUInt8(entry.compressed ? 6 : 0, 19);
      meta.writeUInt32LE(0, 20); // timestamp
      parts.push(meta);
    }
    return Buffer.concat(parts);
  }

  const fileTreeBuf = serializeEntry(root);
  const dataPayload = Buffer.concat(dataChunks);
  const headPayload = Buffer.alloc(headLen);

  const totalPayload = 4 + 8 + headLen + 8 + dataPayload.length + 8 + fileTreeBuf.length;
  const buf = Buffer.alloc(8 + totalPayload);
  let pos = 0;

  buf.write("FORM", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(totalPayload, pos); pos += 4;
  buf.write("PAC1", pos, 4, "ascii"); pos += 4;
  buf.write("HEAD", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(headLen, pos); pos += 4;
  headPayload.copy(buf, pos); pos += headLen;
  buf.write("DATA", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(dataPayload.length, pos); pos += 4;
  dataPayload.copy(buf, pos); pos += dataPayload.length;
  buf.write("FILE", pos, 4, "ascii"); pos += 4;
  buf.writeUInt32BE(fileTreeBuf.length, pos); pos += 4;
  fileTreeBuf.copy(buf, pos);

  return buf;
}

// ── Tests ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "enfusion-mcp-vfs-test-" + process.pid);
const GAME_DIR = join(TEST_DIR, "game");
const ADDONS_DIR = join(GAME_DIR, "addons");

beforeAll(() => {
  mkdirSync(ADDONS_DIR, { recursive: true });

  // Create two pak files to test merging
  const pak1 = buildTestPak([
    { path: "Scripts/Game/player.c", content: "class Player {}", compress: false },
    { path: "Prefabs/box.et", content: 'GenericEntity { ID "box" }', compress: false },
  ]);
  writeFileSync(join(ADDONS_DIR, "data.pak"), pak1);

  const pak2 = buildTestPak([
    { path: "Scripts/Game/vehicle.c", content: "class Vehicle {}", compress: true },
    { path: "Configs/game.conf", content: "GameConfig { mode coop }", compress: true },
  ]);
  writeFileSync(join(ADDONS_DIR, "scripts.pak"), pak2);

  // Reset singleton between test runs
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceGamePath = null;
});

afterAll(() => {
  // Reset singleton
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceGamePath = null;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("PakVirtualFS", () => {
  it("returns null when no addons directory exists", () => {
    const vfs = PakVirtualFS.get(join(TEST_DIR, "nonexistent"));
    expect(vfs).toBeNull();
  });

  it("initializes from pak files in addons/", () => {
    const vfs = PakVirtualFS.get(GAME_DIR);
    expect(vfs).not.toBeNull();
    expect(vfs!.fileCount).toBe(4);
  });

  it("lists root directory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const entries = vfs.listDir("");
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("Scripts");
    expect(names).toContain("Prefabs");
    expect(names).toContain("Configs");
  });

  it("lists subdirectory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const entries = vfs.listDir("Scripts/Game");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["player.c", "vehicle.c"]);
    expect(entries.every((e) => !e.isDirectory)).toBe(true);
  });

  it("returns empty for nonexistent directory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.listDir("DoesNotExist")).toEqual([]);
  });

  it("checks file existence", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.exists("Scripts/Game/player.c")).toBe(true);
    expect(vfs.exists("Scripts/Game/vehicle.c")).toBe(true);
    expect(vfs.exists("nope.c")).toBe(false);
  });

  it("checks directory existence", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.exists("Scripts")).toBe(true);
    expect(vfs.exists("Scripts/Game")).toBe(true);
    expect(vfs.exists("Nonexistent")).toBe(false);
  });

  it("reads uncompressed file", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const content = vfs.readTextFile("Scripts/Game/player.c");
    expect(content).toBe("class Player {}");
  });

  it("reads compressed file", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const content = vfs.readTextFile("Scripts/Game/vehicle.c");
    expect(content).toBe("class Vehicle {}");
  });

  it("reads file as buffer", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const buf = vfs.readFile("Prefabs/box.et");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString("utf-8")).toBe('GenericEntity { ID "box" }');
  });

  it("throws on nonexistent file read", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(() => vfs.readFile("no/such/file.c")).toThrow("File not found in pak");
  });

  it("returns all file paths", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const paths = vfs.allFilePaths().sort();
    expect(paths).toEqual([
      "Configs/game.conf",
      "Prefabs/box.et",
      "Scripts/Game/player.c",
      "Scripts/Game/vehicle.c",
    ]);
  });

  it("caches singleton instance", () => {
    const a = PakVirtualFS.get(GAME_DIR);
    const b = PakVirtualFS.get(GAME_DIR);
    expect(a).toBe(b);
  });
});

describe("PakVirtualFS regression: absolute offsets + zlib-wrapped compression", () => {
  // Regression coverage for the "invalid block type" bug: entry.offset must be
  // treated as an ABSOLUTE byte position within the .pak file, and compressed
  // entries must be inflated as zlib-wrapped deflate (2-byte header + deflate
  // + Adler-32), not raw/headerless deflate. Getting either wrong either
  // throws a zlib error on compressed reads or silently reads/truncates the
  // wrong bytes for uncompressed reads.
  const REG_DIR = join(tmpdir(), "enfusion-mcp-vfs-regress-" + process.pid);
  const REG_ADDONS = join(REG_DIR, "addons");

  beforeAll(() => {
    mkdirSync(REG_ADDONS, { recursive: true });
    // Several files, mixing compressed/uncompressed, so a wrong offset base
    // or wrong codec corrupts more than just the first entry.
    const pak = buildTestPak([
      { path: "a/first.c", content: "class First {}", compress: false },
      {
        path: "a/second.c",
        content: "class Second { void Foo() {} void Bar() {} }".repeat(20),
        compress: true,
      },
      { path: "a/third.c", content: "class Third {}", compress: false },
      {
        path: "a/fourth.c",
        content: "class Fourth { int x; int y; int z; }".repeat(15),
        compress: true,
      },
    ]);
    writeFileSync(join(REG_ADDONS, "regress.pak"), pak);
    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceGamePath = null;
  });

  afterAll(() => {
    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceGamePath = null;
    rmSync(REG_DIR, { recursive: true, force: true });
  });

  it("reads every entry — compressed and uncompressed, sequential — without truncation or zlib errors", () => {
    const vfs = PakVirtualFS.get(REG_DIR)!;
    expect(vfs.readTextFile("a/first.c")).toBe("class First {}");
    expect(vfs.readTextFile("a/second.c")).toBe(
      "class Second { void Foo() {} void Bar() {} }".repeat(20)
    );
    expect(vfs.readTextFile("a/third.c")).toBe("class Third {}");
    expect(vfs.readTextFile("a/fourth.c")).toBe(
      "class Fourth { int x; int y; int z; }".repeat(15)
    );
  });
});

describe("PakVirtualFS decompression codec (hand-built buffer)", () => {
  // Focused unit test pinning the exact codec contract: readFile() must
  // treat compressed pak entries as zlib-wrapped deflate (deflateSync
  // output), not raw/headerless deflate (deflateRawSync output). A
  // hand-built buffer using the wrong codec must fail loudly rather than
  // silently produce garbage.
  const CODEC_DIR = join(tmpdir(), "enfusion-mcp-vfs-codec-" + process.pid);
  const CODEC_ADDONS = join(CODEC_DIR, "addons");

  afterAll(() => {
    rmSync(CODEC_DIR, { recursive: true, force: true });
  });

  it("rejects a raw-deflate (headerless) stream even though the compressed flag is set", () => {
    mkdirSync(CODEC_ADDONS, { recursive: true });
    const pak = buildTestPak([{ path: "bad.c", content: "class Bad {}", compress: true }]);

    // Corrupt: overwrite the zlib-wrapped payload with a raw/headerless
    // deflate stream of the same content, keeping compressedLen/decompressedLen
    // metadata untouched. This simulates the exact bug this fix corrects
    // (reader previously called inflateRawSync on zlib-wrapped data — here we
    // invert it to prove readFile() now truly requires the zlib wrapper).
    const raw = Buffer.from("class Bad {}", "utf-8");
    const rawDeflated: Buffer = deflateRawSync(raw);

    // Locate the zlib-wrapped payload inside the pak buffer and splice in the
    // raw-deflate bytes at the same spot (DATA payload starts right after
    // FORM+HEAD+DATA headers). We just need the first bytes to diverge from a
    // valid zlib header so inflateSync rejects it.
    const dataPayloadAbsStart = 12 + 8 + 0x1c + 8;
    const patched = Buffer.from(pak);
    rawDeflated.copy(patched, dataPayloadAbsStart, 0, Math.min(rawDeflated.length, patched.length - dataPayloadAbsStart));

    writeFileSync(join(CODEC_ADDONS, "codec.pak"), patched);
    (PakVirtualFS as any).instance = null;
    (PakVirtualFS as any).instanceGamePath = null;

    const vfs = PakVirtualFS.get(CODEC_DIR)!;
    expect(() => vfs.readFile("bad.c")).toThrow(/Failed to decompress pak entry/);
  });
});
