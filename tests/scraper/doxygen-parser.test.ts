import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseHierarchyPage,
  parseClassPage,
  parseAnnotatedPage,
  parseGroupPage,
} from "../../src/scraper/doxygen-parser.js";

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const doxygenFixturesDir = resolve(fixturesDir, "doxygen");

describe("parseHierarchyPage", () => {
  const html = readFileSync(resolve(fixturesDir, "sample-hierarchy.html"), "utf-8");
  const nodes = parseHierarchyPage(html);
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));

  it("parses nodes from the table-based Doxygen 1.13 format", () => {
    expect(nodes.length).toBeGreaterThan(100);
  });

  it("correctly identifies root nodes (no parent in the tree)", () => {
    // ActionManager is a root entry in the hierarchy (row_0_)
    expect(nodeMap.has("ActionManager")).toBe(true);
    // AlignableSlot is another root (row_1_)
    expect(nodeMap.has("AlignableSlot")).toBe(true);
  });

  it("correctly identifies parent-child relationships", () => {
    // ActionManager → InputManager
    const am = nodeMap.get("ActionManager");
    expect(am).toBeDefined();
    expect(am!.children).toContain("InputManager");

    // AlignableSlot → ButtonSlot, GridSlot, LayoutSlot, etc.
    const as_ = nodeMap.get("AlignableSlot");
    expect(as_).toBeDefined();
    expect(as_!.children).toContain("ButtonSlot");
    expect(as_!.children).toContain("GridSlot");
    expect(as_!.children).toContain("LayoutSlot");
  });

  it("correctly identifies multi-level nesting", () => {
    // AlignableSlot → LayoutSlot → HorizontalLayoutSlot
    const ls = nodeMap.get("LayoutSlot");
    expect(ls).toBeDefined();
    expect(ls!.children).toContain("HorizontalLayoutSlot");
    expect(ls!.children).toContain("VerticalLayoutSlot");
  });

  it("ScriptComponent is a child of GenericComponent", () => {
    const gc = nodeMap.get("GenericComponent");
    expect(gc).toBeDefined();
    expect(gc!.children).toContain("ScriptComponent");
  });

  it("GenericEntity is a child of IEntity", () => {
    const ie = nodeMap.get("IEntity");
    expect(ie).toBeDefined();
    expect(ie!.children).toContain("GenericEntity");
  });

  it("does not produce circular relationships", () => {
    for (const node of nodes) {
      for (const childName of node.children) {
        const child = nodeMap.get(childName);
        if (child) {
          expect(child.children).not.toContain(node.name);
        }
      }
    }
  });
});

describe("parseClassPage inheritance (map-area heuristic)", () => {
  const html = readFileSync(resolve(fixturesDir, "sample-class.html"), "utf-8");
  const cls = parseClassPage(html, "enfusion", "interfaceIEntity.html");

  it("parses the class name", () => {
    expect(cls.name).toBe("IEntity");
  });

  it("identifies Managed as a parent (above subject in diagram)", () => {
    expect(cls.parents).toContain("Managed");
  });

  it("identifies GenericEntity as a direct child", () => {
    expect(cls.children).toContain("GenericEntity");
  });

  it("does not include grandchildren (indented x) in children", () => {
    // AutotestGrid etc. are at x=179 (indented) — should be excluded
    expect(cls.children).not.toContain("AutotestGrid");
    expect(cls.children).not.toContain("CinematicEntity");
  });

  it("does not classify children as parents", () => {
    // GenericEntity should NOT appear in parents
    expect(cls.parents).not.toContain("GenericEntity");
    // No grandchildren in parents either
    expect(cls.parents).not.toContain("AutotestGrid");
  });
});

// --- Fixtures below are REAL pages fetched from https://arexplorer.zeroy.com/
// (Doxygen 1.17.0 mirror) on 2026-07-03, trimmed for size. See
// docs/superpowers/plans/2026-07-03-faza-5-data-quality.md Task 3.

describe("parseAnnotatedPage against real Doxygen 1.17.0 mirror output", () => {
  const html = readFileSync(
    resolve(doxygenFixturesDir, "real-annotated-sample.html"),
    "utf-8"
  );
  const entries = parseAnnotatedPage(html);

  it("parses class rows with name + url", () => {
    expect(entries.length).toBeGreaterThan(100);
    const am = entries.find((e) => e.name === "ActionManager");
    expect(am).toBeDefined();
    expect(am!.url).toBe("class_action_manager.html");
  });

  it("extracts the brief from td.desc for classes that have one", () => {
    const am = entries.find((e) => e.name === "ActionManager");
    expect(am!.brief).toContain(
      "holds information about states of registered Contexts and Actions"
    );
  });
});

describe("parseClassPage against real Doxygen 1.17.0 mirror output", () => {
  it("extracts the brief from div.contents > p (class with no members)", () => {
    const html = readFileSync(
      resolve(doxygenFixturesDir, "real-class-action-manager.html"),
      "utf-8"
    );
    const cls = parseClassPage(html, "enfusion", "class_action_manager.html");
    expect(cls.name).toBe("ActionManager");
    expect(cls.brief).toContain(
      "holds information about states of registered Contexts and Actions"
    );
  });

  it("enriches method descriptions from the detailed memdoc section", () => {
    // Doxygen 1.17.0 wraps memdoc INSIDE div.memitem (a sibling of h2.memtitle,
    // not memdoc itself directly after the heading). The old `.next("div.memdoc")`
    // selector misses this and leaves methods with only their short mdescRight text.
    const html = readFileSync(
      resolve(doxygenFixturesDir, "real-class-generic-entity.html"),
      "utf-8"
    );
    const cls = parseClassPage(html, "enfusion", "class_generic_entity.html");
    const method = [...cls.protectedMethods, ...cls.methods].find(
      (m) => m.name === "_WB_AfterWorldUpdate"
    );
    expect(method).toBeDefined();
    // The detailed memdoc text is much longer than the short mdescRight brief.
    expect(method!.description).toContain(
      "Called after updating world in Workbench"
    );
  });
});

describe("parseGroupPage enum extraction against real Doxygen 1.17.0 mirror output", () => {
  const html = readFileSync(
    resolve(doxygenFixturesDir, "real-group-core.html"),
    "utf-8"
  );
  const group = parseGroupPage(html);

  it("parses the group name", () => {
    expect(group.name).toBe("Core");
  });

  it("extracts global enums declared in the group's enum-members section", () => {
    expect(group.enums).toBeDefined();
    const achievementId = group.enums!.find((e) => e.name === "AchievementId");
    expect(achievementId).toBeDefined();
  });

  it("extracts enum values with names from the fieldtable", () => {
    const achievementId = group.enums!.find((e) => e.name === "AchievementId");
    const names = achievementId!.values.map((v) => v.name);
    expect(names).toContain("COMBAT_HYGIENE");
    expect(names).toContain("NUTCRACKER");
  });
});

import { deriveBrief } from "../../src/scraper/doxygen-parser.js";

describe("deriveBrief", () => {
  it("cleans an explicit brief: strips 'More...' and leading class name", () => {
    expect(
      deriveBrief("ActionManager holds information about states. More...", "", "ActionManager")
    ).toBe("holds information about states.");
  });
  it("falls back to first sentence of description when brief is empty", () => {
    expect(
      deriveBrief("", "GenericEntity is a base entity. It has more detail here.", "GenericEntity")
    ).toBe("is a base entity.");
  });
  it("returns empty string when both are empty", () => {
    expect(deriveBrief("", "", "X")).toBe("");
  });
  it("does not strip class name when it is not a leading prefix", () => {
    expect(deriveBrief("", "Holds ActionManager references.", "ActionManager")).toBe(
      "Holds ActionManager references."
    );
  });
});

import { isBoilerplateBrief } from "../../src/scraper/doxygen-parser.js";

describe("deriveBrief boilerplate rejection", () => {
  it("rejects Doxygen 'Definition at line N of file' boilerplate", () => {
    expect(deriveBrief("", "Definition at line 7 of file AddonBuildInfoTool.c.", "AddonBuildInfoTool")).toBe("");
  });
  it("rejects an Examples/file-path first sentence", () => {
    expect(deriveBrief("", "ExamplesF:/Games/AReforger/scripts/Game/GameMode/SCR_GameModeEditor.c.", "SCR_BaseGameMode")).toBe("");
  });
  it("keeps a genuine prose brief", () => {
    expect(deriveBrief("", "Holds information about states of registered Contexts and Actions.", "ActionManager")).toBe(
      "Holds information about states of registered Contexts and Actions."
    );
  });
  it("isBoilerplateBrief flags boilerplate and passes prose", () => {
    expect(isBoilerplateBrief("Definition at line 3 of file X.c.")).toBe(true);
    expect(isBoilerplateBrief("Manages the player inventory.")).toBe(false);
  });
});
