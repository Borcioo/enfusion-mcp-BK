import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  loadPitfalls,
  matchPitfalls,
  formatPitfalls,
  type Pitfall,
  type PitfallContext,
} from "../../src/pitfalls/loader.js";

const DATA_DIR = resolve(__dirname, "..", "..", "data");

describe("data/pitfalls.json", () => {
  it("validates against the pitfall schema — every entry has required fields", () => {
    const raw = readFileSync(resolve(DATA_DIR, "pitfalls.json"), "utf-8");
    const pitfalls = JSON.parse(raw) as Pitfall[];

    expect(Array.isArray(pitfalls)).toBe(true);
    expect(pitfalls.length).toBeGreaterThanOrEqual(8);

    const seenIds = new Set<string>();
    for (const p of pitfalls) {
      expect(typeof p.id).toBe("string");
      expect(p.id.length).toBeGreaterThan(0);
      expect(seenIds.has(p.id)).toBe(false);
      seenIds.add(p.id);

      expect(typeof p.title).toBe("string");
      expect(p.title.length).toBeGreaterThan(0);

      expect(typeof p.detail).toBe("string");
      expect(p.detail.length).toBeGreaterThan(0);

      expect(typeof p.appliesWhen).toBe("object");
      expect(p.appliesWhen).not.toBeNull();

      if (p.appliesWhen.keywords !== undefined) {
        expect(Array.isArray(p.appliesWhen.keywords)).toBe(true);
      }
      if (p.appliesWhen.scriptType !== undefined) {
        expect(Array.isArray(p.appliesWhen.scriptType)).toBe(true);
      }
      if (p.appliesWhen.events !== undefined) {
        expect(Array.isArray(p.appliesWhen.events)).toBe(true);
      }
    }
  });

  it("includes the session-specific gotchas called out in the plan", () => {
    const raw = readFileSync(resolve(DATA_DIR, "pitfalls.json"), "utf-8");
    const pitfalls = JSON.parse(raw) as Pitfall[];
    const ids = pitfalls.map((p) => p.id);

    expect(ids).toContain("modded-class-is-global");
    expect(ids).toContain("frame-event-requires-setmask");
    expect(ids).toContain("ref-keyword-reference-types");
    expect(ids).toContain("scripts-outside-module-folder");
    expect(ids).toContain("workbenchgame-handlers-no-hot-reload");
    expect(ids).toContain("getplayermanager-on-chimeragame");
  });
});

describe("loadPitfalls", () => {
  it("loads and parses the real data/pitfalls.json", () => {
    const pitfalls = loadPitfalls(DATA_DIR);
    expect(pitfalls.length).toBeGreaterThan(0);
  });

  it("returns an empty array when the file is missing", () => {
    const pitfalls = loadPitfalls(resolve(DATA_DIR, "..", "does-not-exist"));
    expect(pitfalls).toEqual([]);
  });
});

describe("matchPitfalls", () => {
  const pitfalls: Pitfall[] = [
    {
      id: "frame-event-requires-setmask",
      title: "EntityEvent.FRAME requires SetEventMask",
      detail: "Handling EOnFrame does nothing unless SetEventMask(owner, EntityEvent.FRAME) is called first.",
      appliesWhen: {
        keywords: ["onframe", "eonframe", "entityevent.frame"],
        events: ["FRAME"],
      },
    },
    {
      id: "scripts-outside-module-folder",
      title: "Scripts outside a valid module folder are silently ignored",
      detail: "Place scripts under Scripts/Game/ (or the correct module) or they will not compile.",
      appliesWhen: {
        scriptType: ["component", "gamemode", "action", "entity", "manager", "modded", "basic"],
      },
    },
    {
      id: "modded-class-is-global",
      title: "A modded class is a global override",
      detail: "modded class X affects every instance of X in the game, not just your mod's usage.",
      appliesWhen: {
        scriptType: ["modded"],
      },
    },
    {
      id: "unrelated-pitfall",
      title: "Unrelated",
      detail: "Should never match the contexts used in these tests.",
      appliesWhen: {
        keywords: ["totally-unrelated-keyword-xyz"],
      },
    },
  ];

  it("surfaces the SetEventMask pitfall when context mentions OnFrame", () => {
    const ctx: PitfallContext = { text: "I want to react every frame with OnFrame" };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).toContain("frame-event-requires-setmask");
  });

  it("surfaces the SetEventMask pitfall when context mentions EntityEvent.FRAME", () => {
    const ctx: PitfallContext = { text: "handle EntityEvent.FRAME for ticking" };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).toContain("frame-event-requires-setmask");
  });

  it("surfaces the SetEventMask pitfall when events include FRAME", () => {
    const ctx: PitfallContext = { events: ["FRAME"] };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).toContain("frame-event-requires-setmask");
  });

  it("surfaces the module-folder pitfall for a component script", () => {
    const ctx: PitfallContext = { scriptType: "component" };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).toContain("scripts-outside-module-folder");
  });

  it("surfaces the modded-class-is-global pitfall only for modded scriptType", () => {
    const moddedCtx: PitfallContext = { scriptType: "modded" };
    const matched = matchPitfalls(pitfalls, moddedCtx);
    expect(matched.map((p) => p.id)).toContain("modded-class-is-global");

    const componentCtx: PitfallContext = { scriptType: "component" };
    const matchedComponent = matchPitfalls(pitfalls, componentCtx);
    expect(matchedComponent.map((p) => p.id)).not.toContain("modded-class-is-global");
  });

  it("returns no pitfalls for a completely irrelevant, empty context", () => {
    const ctx: PitfallContext = {};
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched).toEqual([]);
  });

  it("returns no pitfalls when nothing in the context matches any criterion", () => {
    const ctx: PitfallContext = { text: "just a plain harmless description with no traps" };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).not.toContain("frame-event-requires-setmask");
    expect(matched.map((p) => p.id)).not.toContain("unrelated-pitfall");
  });

  it("does not duplicate a pitfall matched by multiple criteria", () => {
    const ctx: PitfallContext = {
      text: "onframe handling",
      events: ["FRAME"],
    };
    const matched = matchPitfalls(pitfalls, ctx);
    const frameMatches = matched.filter((p) => p.id === "frame-event-requires-setmask");
    expect(frameMatches.length).toBe(1);
  });

  it("keyword matching is case-insensitive", () => {
    const ctx: PitfallContext = { text: "Using ONFRAME to animate" };
    const matched = matchPitfalls(pitfalls, ctx);
    expect(matched.map((p) => p.id)).toContain("frame-event-requires-setmask");
  });
});

describe("formatPitfalls", () => {
  it("returns empty string for no pitfalls", () => {
    expect(formatPitfalls([])).toBe("");
  });

  it("formats pitfalls as a readable list including title and detail", () => {
    const text = formatPitfalls([
      {
        id: "x",
        title: "Some Title",
        detail: "Some detail text.",
        appliesWhen: {},
      },
    ]);
    expect(text).toContain("Some Title");
    expect(text).toContain("Some detail text.");
  });
});
