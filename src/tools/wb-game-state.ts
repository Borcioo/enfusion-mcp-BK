import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

interface GameStateEntity {
  className?: string;
  prefabName?: string;
  position?: string;
}

interface GameStatePlayer {
  playerId?: number;
  name?: string;
  position?: string;
}

interface GameStateResult {
  status?: string;
  message?: string;
  action?: string;
  mode?: string;
  worldTime?: number;
  entityCount?: number;
  playerCount?: number;
  totalCount?: number;
  returnedCount?: number;
  offset?: number;
  entities?: GameStateEntity[];
  players?: GameStatePlayer[];
}

/** Shapes the request params sent to EMCP_WB_GameState from tool inputs. */
export function buildGameStateParams(input: {
  action: "world_info" | "list_entities" | "players";
  nameFilter?: string;
  offset?: number;
  limit?: number;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { action: input.action };
  if (input.nameFilter) params.nameFilter = input.nameFilter;
  if (input.offset !== undefined) params.offset = input.offset;
  if (input.limit !== undefined) params.limit = input.limit;
  return params;
}

/** Formats the handler's raw JSON response into the tool's markdown reply. */
export function formatGameStateResult(result: GameStateResult): string {
  if (result.mode === "no_game" || result.mode === "game_no_world") {
    const lines = [
      "**Game State: Not Available**\n",
      `- **Mode:** ${result.mode}`,
      result.message ? `\n${result.message}` : "",
      "\nThis tool only works in PLAY mode. Call `wb_play` first, or wait for the world to finish loading.",
    ];
    return lines.filter(Boolean).join("\n");
  }

  const action = result.action || "world_info";

  if (action === "world_info") {
    const lines = ["**Game World State**\n"];
    if (result.worldTime !== undefined) lines.push(`- **World Time:** ${result.worldTime} ms`);
    if (result.entityCount !== undefined) lines.push(`- **Active Entities:** ${result.entityCount}`);
    if (result.playerCount !== undefined) lines.push(`- **Players:** ${result.playerCount}`);
    if (result.message) lines.push(`\n${result.message}`);
    return lines.join("\n");
  }

  if (action === "list_entities") {
    const entities = Array.isArray(result.entities) ? result.entities : [];
    if (entities.length === 0) {
      return `**No entities found.**${result.message ? `\n${result.message}` : ""}`;
    }
    const lines = [
      `**Entities** (${result.returnedCount ?? entities.length} of ${result.totalCount ?? entities.length}, offset ${result.offset ?? 0})\n`,
    ];
    for (const e of entities) {
      const label = e.prefabName ? `${e.className} (${e.prefabName})` : e.className || "(unknown)";
      lines.push(`- ${label} @ ${e.position || "?"}`);
    }
    return lines.join("\n");
  }

  if (action === "players") {
    const players = Array.isArray(result.players) ? result.players : [];
    if (players.length === 0) {
      return `**No players found.**${result.message ? `\n${result.message}` : ""}`;
    }
    const lines = [`**Players** (${result.playerCount ?? players.length})\n`];
    for (const p of players) {
      lines.push(`- [${p.playerId}] ${p.name || "(unknown)"} @ ${p.position || "?"}`);
    }
    return lines.join("\n");
  }

  return result.message || "Unknown response";
}

export function registerWbGameState(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_game_state",
    {
      description:
        "Inspect the live game world while Workbench is in PLAY mode (Play in Editor). Uses the game-runtime GetGame()/GetWorld() API, so it returns data only while the game is actually running; call wb_play first (if the game isn't running it reports mode 'no_game'). Read-only. Actions: 'world_info' (world time, active entity count, player count), 'list_entities' (active entities in the world, filterable by className/prefabName substring, paginated, capped at 200 per call), 'players' (connected players with controlled-entity positions).",
      inputSchema: {
        action: z
          .enum(["world_info", "list_entities", "players"])
          .default("world_info")
          .describe("Which snapshot to retrieve"),
        nameFilter: z
          .string()
          .optional()
          .describe("Substring filter (case-insensitive) against entity className or prefabName, for list_entities"),
        offset: z.number().min(0).optional().describe("Pagination offset for list_entities"),
        limit: z.number().min(1).max(200).optional().describe("Max entities to return for list_entities (capped at 200)"),
      },
    },
    async ({ action, nameFilter, offset, limit }) => {
      // No requirePlayMode guard: the cached editor mode is unreliable in
      // Workbench "Play in Editor" (the World Editor module stays accessible
      // while the game runs, so wb_state reports "edit" even in play). The
      // handler detects the real runtime via GetGame()/GetWorld() and returns
      // mode "no_game"/"game_no_world"/"game"; formatGameStateResult surfaces a
      // "call wb_play first" message for the non-running cases.
      try {
        const params = buildGameStateParams({ action, nameFilter, offset, limit });
        const result = await client.call<GameStateResult>("EMCP_WB_GameState", params);
        const text = formatGameStateResult(result);
        return { content: [{ type: "text" as const, text: text + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text" as const, text: `Error getting game state (${action}): ${msg}${formatConnectionStatus(client)}` },
          ],
          isError: true,
        };
      }
    }
  );
}
