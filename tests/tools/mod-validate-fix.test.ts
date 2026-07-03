import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";

import {
  checkStructure,
  checkGproj,
  checkScripts,
  checkPrefabs,
  checkNaming,
  checkReferences,
} from "../../src/tools/mod.js";
import { SearchEngine } from "../../src/index/search-engine.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-validate-fix");
const searchEngine = new SearchEngine(dataDir);

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

function goodGproj(id = "TestMod"): string {
  return `GameProject {
 ID "${id}"
 GUID "AAAAAAAAAAAAAAAA"
 Dependencies {
  "58D0FB3206B6F859"
 }
}`;
}

describe("checkScripts fix suggestions", () => {
  it("script outside a valid module folder yields a move fix", () => {
    write("BadScript.c", `class BadClass\n{\n}`);

    const issues = checkScripts(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("outside a valid module folder"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({ action: "move", from: "BadScript.c", to: "Scripts/Game/BadScript.c" });
  });

  it("nested script outside a valid module folder moves by basename", () => {
    write("Extra/Nested/Weird.c", `class Weird\n{\n}`);

    const issues = checkScripts(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("outside a valid module folder"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({
      action: "move",
      from: "Extra/Nested/Weird.c",
      to: "Scripts/Game/Weird.c",
    });
  });

  it("missing class declaration has no mechanical fix", () => {
    write("Scripts/Game/Empty.c", `// just a comment, nothing else\n`);

    const issues = checkScripts(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("No class declaration found"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });
});

describe("checkGproj fix suggestions", () => {
  it("missing Dependencies block yields addDependency fix", () => {
    write(
      "TestMod.gproj",
      `GameProject {\n ID "TestMod"\n GUID "AAAAAAAAAAAAAAAA"\n}`
    );

    const issues = checkGproj(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Missing Dependencies block"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({
      action: "addDependency",
      gproj: "TestMod.gproj",
      dependency: "58D0FB3206B6F859",
    });
  });

  it("missing base game dependency yields addDependency fix", () => {
    write(
      "TestMod.gproj",
      `GameProject {\n ID "TestMod"\n GUID "AAAAAAAAAAAAAAAA"\n Dependencies {\n }\n}`
    );

    const issues = checkGproj(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Missing base game dependency"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({
      action: "addDependency",
      gproj: "TestMod.gproj",
      dependency: "58D0FB3206B6F859",
    });
  });

  it("missing ID field yields setField fix derived from filename", () => {
    write(
      "TestMod.gproj",
      `GameProject {\n GUID "AAAAAAAAAAAAAAAA"\n Dependencies {\n  "58D0FB3206B6F859"\n }\n}`
    );

    const issues = checkGproj(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Missing ID field"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({
      action: "setField",
      file: "TestMod.gproj",
      field: "ID",
      value: "TestMod",
    });
  });

  it("missing GUID has no mechanical fix (no single correct value)", () => {
    write(
      "TestMod.gproj",
      `GameProject {\n ID "TestMod"\n Dependencies {\n  "58D0FB3206B6F859"\n }\n}`
    );

    const issues = checkGproj(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Missing GUID field"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });

  it("wrong root node type has no mechanical fix", () => {
    write("TestMod.gproj", `NotAGameProject {\n ID "TestMod"\n}`);

    const issues = checkGproj(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Root node is"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });
});

describe("checkStructure fix suggestions", () => {
  it("missing expected directory yields a create fix", () => {
    write("TestMod.gproj", goodGproj());

    const issues = checkStructure(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Missing expected directory"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toEqual({
      action: "create",
      path: "Scripts/Game",
      contentHint: "empty directory for Game module scripts",
    });
  });

  it("missing .gproj has no mechanical fix (can't derive ID/GUID)", () => {
    write("Scripts/Game/Test.c", `class Test\n{\n}`);

    const issues = checkStructure(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("No .gproj file found"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });

  it("multiple .gproj files has no mechanical fix (ambiguous)", () => {
    write("A.gproj", goodGproj("A"));
    write("B.gproj", goodGproj("B"));

    const issues = checkStructure(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Multiple .gproj files"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });
});

describe("checkPrefabs fix suggestions", () => {
  it("invalid prefab format has no mechanical fix", () => {
    write("TestMod.gproj", goodGproj());
    write("Prefabs/Bad.et", "this is not valid enfusion text {{{}}}");

    const issues = checkPrefabs(TEST_DIR);
    const issue = issues.find((i) => i.message.includes("Invalid prefab format"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });
});

describe("checkNaming fix suggestions", () => {
  it("minority-prefix class yields a rename fix to the majority prefix", () => {
    write("Scripts/Game/TM_A.c", `class TM_A : ScriptComponent\n{\n}`);
    write("Scripts/Game/TM_B.c", `class TM_B : ScriptComponent\n{\n}`);
    write("Scripts/Game/ZD_Odd.c", `class ZD_Odd : ScriptComponent\n{\n}`);

    const issues = checkNaming(TEST_DIR);
    expect(issues.length).toBe(1);
    expect(issues[0].fix).toEqual({ action: "rename", from: "ZD_Odd", to: "TM_Odd" });
  });

  it("consistent prefixes across all classes produce no issues", () => {
    write("Scripts/Game/TM_A.c", `class TM_A : ScriptComponent\n{\n}`);
    write("Scripts/Game/TM_B.c", `class TM_B : ScriptComponent\n{\n}`);

    const issues = checkNaming(TEST_DIR);
    expect(issues.length).toBe(0);
  });
});

describe("checkReferences fix suggestions", () => {
  it("unknown parent class has no mechanical fix", () => {
    write("Scripts/Game/Test.c", `class Test : TotallyMadeUpBaseClass\n{\n}`);

    const issues = checkReferences(TEST_DIR, searchEngine);
    const issue = issues.find((i) => i.message.includes("not in the API index"));
    expect(issue).toBeDefined();
    expect(issue!.fix).toBeUndefined();
  });
});
