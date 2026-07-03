import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, extname } from "node:path";

import { PatternLibrary } from "../../src/patterns/loader.js";

const REAL_PATTERNS_DIR = resolve(import.meta.dirname, "../../data/patterns");

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("PatternLibrary — codeExamples parsing", () => {
  it("parses codeExamples from a pattern JSON file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pattern-loader-"));
    writeFileSync(
      join(tmpDir, "example-pattern.json"),
      JSON.stringify({
        name: "Example Pattern",
        description: "A pattern for testing",
        tags: ["test"],
        scripts: [],
        prefabs: [],
        configs: [],
        instructions: "Do the thing.",
        codeExamples: [
          {
            title: "Do a thing",
            description: "Shows how to do the thing.",
            code: "void DoThing()\n{\n  Print(\"hi\");\n}",
          },
        ],
      }),
      "utf-8"
    );

    const lib = new PatternLibrary(tmpDir);
    const pattern = lib.get("example-pattern");

    expect(pattern).toBeDefined();
    expect(pattern!.codeExamples).toHaveLength(1);
    expect(pattern!.codeExamples![0].title).toBe("Do a thing");
    expect(pattern!.codeExamples![0].code).toContain("DoThing");
  });

  it("leaves codeExamples undefined when the pattern JSON omits it", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pattern-loader-"));
    writeFileSync(
      join(tmpDir, "no-examples.json"),
      JSON.stringify({
        name: "No Examples",
        description: "A pattern without examples",
        tags: [],
        scripts: [],
        prefabs: [],
        configs: [],
        instructions: "Do nothing special.",
      }),
      "utf-8"
    );

    const lib = new PatternLibrary(tmpDir);
    const pattern = lib.get("no-examples");

    expect(pattern).toBeDefined();
    expect(pattern!.codeExamples).toBeUndefined();
  });

  it("getExamplesBlock() is empty when no pattern has examples", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pattern-loader-"));
    writeFileSync(
      join(tmpDir, "no-examples.json"),
      JSON.stringify({
        name: "No Examples",
        description: "desc",
        tags: [],
        scripts: [],
        prefabs: [],
        configs: [],
        instructions: "instr",
      }),
      "utf-8"
    );

    const lib = new PatternLibrary(tmpDir);
    expect(lib.getExamplesBlock()).toBe("");
  });

  it("getExamplesBlock() includes title, description and code for patterns with examples", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "pattern-loader-"));
    writeFileSync(
      join(tmpDir, "with-examples.json"),
      JSON.stringify({
        name: "With Examples",
        description: "desc",
        tags: [],
        scripts: [],
        prefabs: [],
        configs: [],
        instructions: "instr",
        codeExamples: [
          {
            title: "Sample Snippet",
            description: "Explains the snippet.",
            code: "void Foo() {}",
          },
        ],
      }),
      "utf-8"
    );

    const lib = new PatternLibrary(tmpDir);
    const block = lib.getExamplesBlock();

    expect(block).toContain("With Examples");
    expect(block).toContain("Sample Snippet");
    expect(block).toContain("Explains the snippet.");
    expect(block).toContain("void Foo() {}");
  });
});

describe("data/patterns/*.json — structural validity", () => {
  const files = readdirSync(REAL_PATTERNS_DIR).filter((f) => extname(f) === ".json");

  it("finds pattern files to validate", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const raw = readFileSync(join(REAL_PATTERNS_DIR, file), "utf-8");
      const pattern = JSON.parse(raw);

      it("has the required base fields", () => {
        expect(typeof pattern.name).toBe("string");
        expect(pattern.name.length).toBeGreaterThan(0);
        expect(typeof pattern.description).toBe("string");
        expect(Array.isArray(pattern.tags)).toBe(true);
        expect(Array.isArray(pattern.scripts)).toBe(true);
        expect(Array.isArray(pattern.prefabs)).toBe(true);
        expect(Array.isArray(pattern.configs)).toBe(true);
        expect(typeof pattern.instructions).toBe("string");
      });

      it("has well-formed, non-empty codeExamples when present", () => {
        if (pattern.codeExamples === undefined) {
          return;
        }

        expect(Array.isArray(pattern.codeExamples)).toBe(true);
        expect(pattern.codeExamples.length).toBeGreaterThan(0);

        for (const example of pattern.codeExamples) {
          expect(typeof example.title).toBe("string");
          expect(example.title.trim().length).toBeGreaterThan(0);

          expect(typeof example.description).toBe("string");
          expect(example.description.trim().length).toBeGreaterThan(0);

          expect(typeof example.code).toBe("string");
          const trimmedCode = example.code.trim();
          expect(trimmedCode.length).toBeGreaterThan(0);

          const lineCount = trimmedCode.split("\n").length;
          expect(lineCount).toBeGreaterThanOrEqual(2);
          expect(lineCount).toBeLessThanOrEqual(20);
        }
      });
    });
  }
});

describe("loaded via PatternLibrary against the real data/patterns dir", () => {
  it("loads all pattern files without error", () => {
    const lib = new PatternLibrary(REAL_PATTERNS_DIR);
    const names = lib.list();
    expect(names.length).toBeGreaterThan(0);

    for (const key of names) {
      const pattern = lib.get(key);
      expect(pattern).toBeDefined();
    }
  });

  it("at least one shipped pattern has codeExamples", () => {
    const lib = new PatternLibrary(REAL_PATTERNS_DIR);
    const withExamples = lib.getAll().filter((p) => p.codeExamples && p.codeExamples.length > 0);
    expect(withExamples.length).toBeGreaterThan(0);
  });
});
