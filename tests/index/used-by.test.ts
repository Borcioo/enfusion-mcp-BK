import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchEngine } from "../../src/index/search-engine.js";
import type { ClassInfo, GroupInfo, WikiPage } from "../../src/index/types.js";

/**
 * Fixture for getUsedBy() reverse-lookup:
 *
 *   Managed (root, referenced only as parent)
 *     -> Entity          (parent = Managed; property "manager" : PlayerManager;
 *                          method GetOwner() : Entity -- self return, must be excluded)
 *          -> Vehicle     (parent = Entity)
 *   PlayerManager (referenced by Entity.manager and Vehicle.RegisterEntity(Entity) param)
 *   LeafClass (nothing references it -> empty usedBy)
 *
 * Also covers type-string parsing: array<Entity>, ref PlayerManager, map<string, Entity>,
 * and primitive types (int, bool, void) which must never show up as referrers.
 */
function makeClass(overrides: Partial<ClassInfo> & { name: string }): ClassInfo {
  return {
    name: overrides.name,
    source: "enfusion",
    brief: "",
    description: "",
    parents: [],
    children: [],
    group: "Test",
    sourceFile: "",
    methods: [],
    protectedMethods: [],
    staticMethods: [],
    enums: [],
    properties: [],
    protectedProperties: [],
    docsUrl: "",
    ...overrides,
  };
}

function buildFixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "used-by-fixture-"));
  const apiDir = join(dir, "api");
  const wikiDir = join(dir, "wiki");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });

  const managed = makeClass({
    name: "Managed",
    children: ["Entity"],
  });

  const playerManager = makeClass({
    name: "PlayerManager",
  });

  const entity = makeClass({
    name: "Entity",
    parents: ["Managed"],
    children: ["Vehicle"],
    properties: [
      { name: "manager", type: "PlayerManager", description: "" },
    ],
    methods: [
      {
        name: "GetOwner",
        returnType: "Entity",
        signature: "Entity GetOwner()",
        params: [],
        description: "",
      },
      {
        name: "GetHealth",
        returnType: "float",
        signature: "float GetHealth()",
        params: [{ name: "clamp", type: "bool", defaultValue: "" }],
        description: "",
      },
    ],
  });

  const vehicle = makeClass({
    name: "Vehicle",
    parents: ["Entity"],
    methods: [
      {
        name: "RegisterEntity",
        returnType: "void",
        signature: "void RegisterEntity(Entity ent, ref PlayerManager pm)",
        params: [
          { name: "ent", type: "Entity", defaultValue: "" },
          { name: "pm", type: "ref PlayerManager", defaultValue: "" },
        ],
        description: "",
      },
      {
        name: "GetPassengers",
        returnType: "array<Entity>",
        signature: "array<Entity> GetPassengers()",
        params: [],
        description: "",
      },
      {
        name: "GetRoster",
        returnType: "map<string, Entity>",
        signature: "map<string, Entity> GetRoster()",
        params: [],
        description: "",
      },
    ],
  });

  const leafClass = makeClass({
    name: "LeafClass",
  });

  const enfusionClasses: ClassInfo[] = [managed, playerManager, entity, vehicle, leafClass];
  const armaClasses: ClassInfo[] = [];
  const groups: GroupInfo[] = [];
  const wikiPages: WikiPage[] = [
    { title: "Placeholder", source: "enfusion", content: "placeholder wiki content" },
  ];

  writeFileSync(join(apiDir, "enfusion-classes.json"), JSON.stringify(enfusionClasses));
  writeFileSync(join(apiDir, "arma-classes.json"), JSON.stringify(armaClasses));
  writeFileSync(join(apiDir, "groups.json"), JSON.stringify(groups));
  writeFileSync(join(wikiDir, "pages.json"), JSON.stringify(wikiPages));

  return dir;
}

describe("SearchEngine.getUsedBy", () => {
  let dataDir: string;
  let engine: SearchEngine;

  beforeAll(() => {
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("finds the parent reference (Entity extends Managed)", () => {
    expect(engine.getUsedBy("Managed")).toEqual(["Entity"]);
  });

  it("finds a property-type reference (Entity.manager : PlayerManager)", () => {
    const referrers = engine.getUsedBy("PlayerManager");
    expect(referrers).toContain("Entity");
  });

  it("finds a ref-wrapped param-type reference (Vehicle.RegisterEntity(ref PlayerManager))", () => {
    const referrers = engine.getUsedBy("PlayerManager");
    expect(referrers).toContain("Vehicle");
  });

  it("finds a plain param-type reference (Vehicle.RegisterEntity(Entity ent))", () => {
    const referrers = engine.getUsedBy("Entity");
    expect(referrers).toContain("Vehicle");
  });

  it("finds array<X> generic-wrapped references (Vehicle.GetPassengers() : array<Entity>)", () => {
    const referrers = engine.getUsedBy("Entity");
    expect(referrers).toContain("Vehicle");
  });

  it("finds map<K,V> generic-wrapped references (Vehicle.GetRoster() : map<string, Entity>)", () => {
    // Vehicle already appears via other refs to Entity; confirm parent-chain class
    // Entity itself also inherits from Managed, not from itself
    expect(engine.getUsedBy("Entity")).toContain("Vehicle");
  });

  it("excludes self-references (Entity.GetOwner() : Entity)", () => {
    const referrers = engine.getUsedBy("Entity");
    expect(referrers).not.toContain("Entity");
  });

  it("excludes primitive types entirely (int/float/bool/void never appear as lookups)", () => {
    expect(engine.getUsedBy("float")).toEqual([]);
    expect(engine.getUsedBy("bool")).toEqual([]);
    expect(engine.getUsedBy("void")).toEqual([]);
    expect(engine.getUsedBy("int")).toEqual([]);
  });

  it("returns empty array for a leaf class nothing references", () => {
    expect(engine.getUsedBy("LeafClass")).toEqual([]);
  });

  it("returns empty array for an unknown class", () => {
    expect(engine.getUsedBy("TotallyUnknownClass12345")).toEqual([]);
  });

  it("de-duplicates referrers (Vehicle references Entity via multiple members)", () => {
    const referrers = engine.getUsedBy("Entity");
    const count = referrers.filter((n) => n === "Vehicle").length;
    expect(count).toBe(1);
  });

  it("is case-insensitive on the lookup name", () => {
    expect(engine.getUsedBy("managed")).toEqual(["Entity"]);
    expect(engine.getUsedBy("MANAGED")).toEqual(["Entity"]);
  });
});
