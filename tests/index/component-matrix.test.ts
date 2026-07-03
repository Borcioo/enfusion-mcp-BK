import { describe, it, expect } from "vitest";
import {
  extractEntityComponents,
  buildComponentMatrix,
  getTypicalComponents,
  listEntityTypes,
} from "../../src/index/component-matrix.js";

const WEAPON_1 = `GenericEntity {
  components {
   MeshObject "{AAAAAAAAAAAAAAAA}" {
    Object "weapon1.xob"
   }
   RplComponent "{BBBBBBBBBBBBBBBB}" {
   }
   SCR_WeaponComponent "{CCCCCCCCCCCCCCCC}" {
   }
  }
}`;

const WEAPON_2 = `GenericEntity {
  components {
   MeshObject "{DDDDDDDDDDDDDDDD}" {
    Object "weapon2.xob"
   }
   SCR_WeaponComponent "{EEEEEEEEEEEEEEEE}" {
   }
  }
}`;

const CHARACTER_1 = `SCR_ChimeraCharacter {
  components {
   CharacterAnimationComponent "{1111111111111111}" {
   }
   MeshObject "{2222222222222222}" {
   }
  }
}`;

const NO_COMPONENTS_ENTITY = `GenericEntity {
  ID "abc"
}`;

// An .et that inherits from a parent prefab via `EntityClass : "{GUID}Parent.et" { ... }`
// and declares only an override/addition in its own components block. Real base-game
// prefabs commonly look like this — most of their effective components come from the
// parent chain and are never re-declared locally.
const INHERITING_ENTITY = `SCR_ChimeraCharacter : "{1234567890ABCDEF}BaseCharacter.et" {
  components {
   NewComp "{9999999999999999}" {
   }
  }
}`;

describe("extractEntityComponents", () => {
  it("extracts entity type and component class names from a .et file", () => {
    const result = extractEntityComponents(WEAPON_1);
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("GenericEntity");
    expect(result!.components).toEqual(["MeshObject", "RplComponent", "SCR_WeaponComponent"]);
  });

  it("returns an empty components array when there is no components block", () => {
    const result = extractEntityComponents(NO_COMPONENTS_ENTITY);
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("GenericEntity");
    expect(result!.components).toEqual([]);
  });

  it("returns null for unparsable text", () => {
    expect(extractEntityComponents("{{{ not valid")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(extractEntityComponents("")).toBeNull();
  });

  // Documents/locks the current, intentional local-only behavior: inherited
  // components from a parent prefab (`EntityClass : "{GUID}Parent.et" { ... }`)
  // are NOT resolved. Only the locally-declared override/addition is recorded.
  // See the docstring on extractEntityComponents for the rationale.
  it("records only locally-declared components for an .et that inherits from a parent prefab", () => {
    const result = extractEntityComponents(INHERITING_ENTITY);
    expect(result).not.toBeNull();
    expect(result!.entityType).toBe("SCR_ChimeraCharacter");
    // Only NewComp — components inherited from BaseCharacter.et are not included.
    expect(result!.components).toEqual(["NewComp"]);
  });
});

describe("buildComponentMatrix", () => {
  it("aggregates co-occurrence counts across multiple .et files of the same entity type", () => {
    const matrix = buildComponentMatrix([WEAPON_1, WEAPON_2]);
    expect(Object.keys(matrix)).toEqual(["GenericEntity"]);
    const entry = matrix["GenericEntity"];
    expect(entry.fileCount).toBe(2);
    expect(entry.components["MeshObject"]).toBe(2);
    expect(entry.components["SCR_WeaponComponent"]).toBe(2);
    expect(entry.components["RplComponent"]).toBe(1);
  });

  it("keeps separate stats per entity type", () => {
    const matrix = buildComponentMatrix([WEAPON_1, CHARACTER_1]);
    expect(Object.keys(matrix).sort()).toEqual(["GenericEntity", "SCR_ChimeraCharacter"]);
    expect(matrix["SCR_ChimeraCharacter"].components["CharacterAnimationComponent"]).toBe(1);
    expect(matrix["SCR_ChimeraCharacter"].components["MeshObject"]).toBe(1);
    expect(matrix["GenericEntity"].components["CharacterAnimationComponent"]).toBeUndefined();
  });

  it("skips unparsable files without throwing", () => {
    const matrix = buildComponentMatrix([WEAPON_1, "{{{ garbage", ""]);
    expect(matrix["GenericEntity"].fileCount).toBe(1);
  });

  it("returns an empty matrix for no input", () => {
    expect(buildComponentMatrix([])).toEqual({});
  });

  it("does not resolve inherited components from a parent .et prefab, only local overrides", () => {
    const matrix = buildComponentMatrix([INHERITING_ENTITY]);
    const entry = matrix["SCR_ChimeraCharacter"];
    expect(entry.fileCount).toBe(1);
    expect(Object.keys(entry.components)).toEqual(["NewComp"]);
    // Components that would only exist via BaseCharacter.et's ancestry (e.g.
    // CharacterAnimationComponent, MeshObject from CHARACTER_1-style base prefabs)
    // are absent — this is the documented local-only behavior, not a bug.
    expect(entry.components["CharacterAnimationComponent"]).toBeUndefined();
    expect(entry.components["MeshObject"]).toBeUndefined();
  });
});

describe("getTypicalComponents", () => {
  it("ranks components by co-occurrence count, descending", () => {
    const matrix = buildComponentMatrix([WEAPON_1, WEAPON_2]);
    const ranked = getTypicalComponents(matrix, "GenericEntity");
    expect(ranked[0].component).toBe("MeshObject");
    expect(ranked[0].count).toBe(2);
    expect(ranked[0].frequency).toBe(1);
    const rpl = ranked.find((r) => r.component === "RplComponent")!;
    expect(rpl.count).toBe(1);
    expect(rpl.frequency).toBe(0.5);
  });

  it("returns an empty array for an unknown entity type", () => {
    const matrix = buildComponentMatrix([WEAPON_1]);
    expect(getTypicalComponents(matrix, "TotallyUnknownEntity")).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const matrix = buildComponentMatrix([WEAPON_1]);
    const ranked = getTypicalComponents(matrix, "GenericEntity", 1);
    expect(ranked.length).toBe(1);
  });
});

describe("listEntityTypes", () => {
  it("lists all known entity types sorted by file count descending", () => {
    const matrix = buildComponentMatrix([WEAPON_1, WEAPON_2, CHARACTER_1]);
    const types = listEntityTypes(matrix);
    expect(types).toEqual([
      { entityType: "GenericEntity", fileCount: 2 },
      { entityType: "SCR_ChimeraCharacter", fileCount: 1 },
    ]);
  });
});
