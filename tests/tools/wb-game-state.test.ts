import { describe, it, expect } from "vitest";
import { buildGameStateParams, formatGameStateResult } from "../../src/tools/wb-game-state.js";

describe("buildGameStateParams", () => {
  it("only includes action when no optional filters are given", () => {
    expect(buildGameStateParams({ action: "world_info" })).toEqual({ action: "world_info" });
  });

  it("includes nameFilter, offset, and limit when provided", () => {
    expect(
      buildGameStateParams({ action: "list_entities", nameFilter: "GameModeSF", offset: 10, limit: 25 })
    ).toEqual({ action: "list_entities", nameFilter: "GameModeSF", offset: 10, limit: 25 });
  });

  it("includes offset 0 explicitly rather than treating it as absent", () => {
    expect(buildGameStateParams({ action: "list_entities", offset: 0, limit: 50 })).toEqual({
      action: "list_entities",
      offset: 0,
      limit: 50,
    });
  });
});

describe("formatGameStateResult", () => {
  it("reports unavailability when GetGame() returned null", () => {
    const text = formatGameStateResult({
      status: "ok",
      mode: "no_game",
      message: "GetGame() returned null. Not in PLAY mode, or the game runtime is not initialized yet.",
    });
    expect(text).toContain("Not Available");
    expect(text).toContain("no_game");
    expect(text).toContain("wb_play");
  });

  it("reports unavailability when GetWorld() returned null", () => {
    const text = formatGameStateResult({
      mode: "game_no_world",
      message: "GetGame() is available but GetWorld() returned null (world not fully loaded yet).",
    });
    expect(text).toContain("game_no_world");
  });

  it("formats world_info with time, entity count and player count", () => {
    const text = formatGameStateResult({
      action: "world_info",
      mode: "game",
      worldTime: 123456.5,
      entityCount: 42,
      playerCount: 1,
      message: "World info: 42 active entities, 1 players, worldTime=123456.5ms",
    });
    expect(text).toContain("Game World State");
    expect(text).toContain("123456.5 ms");
    expect(text).toContain("42");
    expect(text).toContain("Players:** 1");
  });

  it("formats list_entities with pagination header and entity lines", () => {
    const text = formatGameStateResult({
      action: "list_entities",
      mode: "game",
      totalCount: 5,
      returnedCount: 2,
      offset: 0,
      entities: [
        { className: "SCR_GameModeSF", prefabName: "GameMode_SF.et", position: "100 5 200" },
        { className: "SCR_ChimeraCharacter", position: "50 5 60" },
      ],
    });
    expect(text).toContain("Entities");
    expect(text).toContain("2 of 5");
    expect(text).toContain("SCR_GameModeSF (GameMode_SF.et) @ 100 5 200");
    expect(text).toContain("SCR_ChimeraCharacter @ 50 5 60");
  });

  it("reports no entities found when the list is empty", () => {
    const text = formatGameStateResult({ action: "list_entities", mode: "game", entities: [] });
    expect(text).toContain("No entities found");
  });

  it("formats players with id, name and position", () => {
    const text = formatGameStateResult({
      action: "players",
      mode: "game",
      playerCount: 1,
      players: [{ playerId: 1, name: "TestPlayer", position: "10 5 10" }],
    });
    expect(text).toContain("Players");
    expect(text).toContain("[1] TestPlayer @ 10 5 10");
  });

  it("reports no players found when the list is empty", () => {
    const text = formatGameStateResult({ action: "players", mode: "game", players: [] });
    expect(text).toContain("No players found");
  });
});
