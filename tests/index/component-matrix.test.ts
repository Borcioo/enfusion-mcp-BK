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
