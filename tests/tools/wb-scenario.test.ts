import { describe, it, expect } from "vitest";
import { slotAiPlacements } from "../../src/tools/wb-scenario.js";

describe("slotAiPlacements", () => {
  it("count 1 uses the legacy plain name with zero offset", () => {
    const result = slotAiPlacements("T", 1);
    expect(result).toEqual([{ name: "T_SlotAI", offset: [0, 0, 0] }]);
  });

  it("count 3 with an offset numbers the slots and accumulates the offset", () => {
    const result = slotAiPlacements("T", 3, "5 0 0");
    expect(result).toEqual([
      { name: "T_SlotAI_1", offset: [0, 0, 0] },
      { name: "T_SlotAI_2", offset: [5, 0, 0] },
      { name: "T_SlotAI_3", offset: [10, 0, 0] },
    ]);
  });

  it("treats an invalid offset string as zero offset rather than throwing", () => {
    const result = slotAiPlacements("T", 2, "not a vector");
    expect(result).toEqual([
      { name: "T_SlotAI_1", offset: [0, 0, 0] },
      { name: "T_SlotAI_2", offset: [0, 0, 0] },
    ]);
  });
});
