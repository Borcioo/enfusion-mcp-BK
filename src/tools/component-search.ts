import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import type { SearchEngine, ComponentSearchResult } from "../index/search-engine.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";
import {
  buildComponentMatrix,
  getTypicalComponents,
  type ComponentMatrix,
} from "../index/component-matrix.js";
import {
  fingerprintLooseTree,
  fingerprintPaks,
  looseFingerprintsMatch,
  pakFingerprintsMatch,
} from "../utils/asset-index-cache.js";
import {
  loadPersistedComponentMatrix,
  savePersistedComponentMatrix,
} from "../utils/component-matrix-cache.js";

function formatComponentResult(result: ComponentSearchResult, verbose: boolean): string {
  const { component: cls, categories, eventHandlers } = result;
  const lines: string[] = [];

  lines.push(`## ${cls.name}`);
  lines.push(`Source: ${cls.source === "enfusion" ? "Enfusion Engine" : "Arma Reforger"} API`);
  lines.push(`Category: ${categories.join(", ")}`);
  if (cls.parents.length > 0) lines.push(`Extends: ${cls.parents.join(", ")}`);
  if (cls.group) lines.push(`Group: ${cls.group}`);

  if (cls.brief) {
    lines.push("");
    lines.push(cls.brief);
  }

  if (verbose && cls.description && cls.description !== cls.brief) {
    lines.push("");
    lines.push(cls.description);
  }

  // Event handlers
  if (eventHandlers.length > 0) {
    lines.push("");
    lines.push(`### Event Handlers (${eventHandlers.length})`);
    for (const handler of eventHandlers) {
      // Find the full signature for this handler
      const allMethods = [...(cls.methods || []), ...(cls.protectedMethods || [])];
      const method = allMethods.find((m) => m.name === handler);
      if (method) {
        const desc = method.description ? ` -- ${method.description}` : "";
        lines.push(`- ${method.signature}${desc}`);
      } else {
        lines.push(`- ${handler}()`);
      }
    }
  }

  if (verbose) {
    // Non-event public methods
    const nonEventMethods = (cls.methods || []).filter((m) => !/^(EOn|On)[A-Z]/.test(m.name));
    if (nonEventMethods.length > 0) {
      const shown = nonEventMethods.slice(0, 10);
      lines.push("");
      lines.push(`### Public Methods (${nonEventMethods.length})`);
      for (const m of shown) {
        const desc = m.description ? ` -- ${m.description}` : "";
        lines.push(`- ${m.signature}${desc}`);
      }
      if (nonEventMethods.length > 10) {
        lines.push(`  ... and ${nonEventMethods.length - 10} more`);
      }
    }

    // Protected methods (non-event)
    const nonEventProtected = (cls.protectedMethods || []).filter((m) => !/^(EOn|On)[A-Z]/.test(m.name));
    if (nonEventProtected.length > 0) {
      const shown = nonEventProtected.slice(0, 10);
      lines.push("");
      lines.push(`### Protected Methods (${nonEventProtected.length})`);
      for (const m of shown) {
        const desc = m.description ? ` -- ${m.description}` : "";
        lines.push(`- ${m.signature}${desc}`);
      }
      if (nonEventProtected.length > 10) {
        lines.push(`  ... and ${nonEventProtected.length - 10} more`);
      }
    }

    // Properties
    const properties = cls.properties || [];
    if (properties.length > 0) {
      const shown = properties.slice(0, 10);
      lines.push("");
      lines.push(`### Properties (${properties.length})`);
      for (const p of shown) {
        const desc = p.description ? ` -- ${p.description}` : "";
        lines.push(`- ${p.type} **${p.name}**${desc}`);
      }
      if (properties.length > 10) {
        lines.push(`  ... and ${properties.length - 10} more`);
      }
    }

    // Children
    if (cls.children.length > 0) {
      const shown = cls.children.slice(0, 10);
      const suffix = cls.children.length > 10 ? ` ... and ${cls.children.length - 10} more` : "";
      lines.push("");
      lines.push(`Direct subclasses: ${shown.join(", ")}${suffix}`);
    }
  }

  if (cls.docsUrl) {
    lines.push("");
    lines.push(`Docs: ${cls.docsUrl}`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Component compatibility matrix — which components co-occur on which
// root entity types, mined from base-game .et prefabs (loose + .pak).
// ---------------------------------------------------------------------------

/** In-memory cache — fast repeat calls within a session. */
let cachedMatrix: ComponentMatrix | null = null;
let cachedMatrixBasePath: string | null = null;

/** Test-only counter: how many times the matrix was actually rebuilt from .et files. */
let matrixBuildCount = 0;
export function __getMatrixBuildCountForTest(): number {
  return matrixBuildCount;
}

export function invalidateComponentMatrixCache(): void {
  cachedMatrix = null;
  cachedMatrixBasePath = null;
}

/** Walk the loose asset tree + .pak archives and collect the text of every .et prefab. */
function collectEtTexts(basePath: string, gamePath: string): string[] {
  const texts: string[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (extname(entry.name).toLowerCase() === ".et") {
        try {
          texts.push(readFileSync(fullPath, "utf-8"));
        } catch (e) {
          logger.warn(`Component matrix: failed to read ${fullPath}: ${e}`);
        }
      }
    }
  }
  walk(basePath);

  try {
    const pakVfs = PakVirtualFS.get(gamePath);
    if (pakVfs) {
      for (const filePath of pakVfs.allFilePaths()) {
        if (extname(filePath).toLowerCase() !== ".et") continue;
        try {
          texts.push(pakVfs.readTextFile(filePath));
        } catch (e) {
          logger.warn(`Component matrix: failed to read pak entry ${filePath}: ${e}`);
        }
      }
    }
  } catch (e) {
    logger.warn(`Component matrix: failed to read pak files: ${e}`);
  }

  return texts;
}

function buildMatrix(basePath: string, gamePath: string): ComponentMatrix {
  matrixBuildCount++;
  const start = Date.now();
  const texts = collectEtTexts(basePath, gamePath);
  const matrix = buildComponentMatrix(texts);
  logger.info(
    `Component matrix built: ${texts.length} .et files, ${Object.keys(matrix).length} entity types, in ${Date.now() - start}ms`
  );
  return matrix;
}

/**
 * Get the component matrix, preferring (in order): the in-memory cache, the
 * on-disk persistent cache (if its mtime fingerprints still match the
 * current game install), or a full rebuild scanning all .et prefabs.
 */
function getComponentMatrix(basePath: string, gamePath: string, forceRefresh = false): ComponentMatrix {
  if (!forceRefresh && cachedMatrix && cachedMatrixBasePath === basePath) {
    return cachedMatrix;
  }

  const looseFp = fingerprintLooseTree(basePath);
  const pakFp = fingerprintPaks(gamePath);

  if (!forceRefresh) {
    const persisted = loadPersistedComponentMatrix(basePath, gamePath);
    if (
      persisted &&
      looseFingerprintsMatch(persisted.looseFingerprint, looseFp) &&
      pakFingerprintsMatch(persisted.pakFingerprints, pakFp)
    ) {
      cachedMatrix = persisted.matrix;
      cachedMatrixBasePath = basePath;
      logger.info(`Component matrix loaded from persistent cache (no rebuild)`);
      return cachedMatrix;
    }
  }

  cachedMatrix = buildMatrix(basePath, gamePath);
  cachedMatrixBasePath = basePath;
  savePersistedComponentMatrix({
    basePath,
    gamePath,
    looseFingerprint: looseFp,
    pakFingerprints: pakFp,
    matrix: cachedMatrix,
  });
  return cachedMatrix;
}

function formatTypicalComponents(entityType: string, ranked: ReturnType<typeof getTypicalComponents>): string {
  if (ranked.length === 0) {
    return `No component data found for entity type "${entityType}". It may not appear in any scanned base-game .et prefab, or the name doesn't match exactly (entity type names are case-sensitive, e.g. "GenericEntity", "SCR_ChimeraCharacter", "Vehicle").`;
  }
  const lines: string[] = [];
  lines.push(`Typical components for entity type "${entityType}" (${ranked.length} distinct components found):\n`);
  for (const r of ranked) {
    lines.push(`- ${r.component} — ${r.count} prefab${r.count !== 1 ? "s" : ""} (${Math.round(r.frequency * 100)}%)`);
  }
  return lines.join("\n");
}

export function registerComponentSearch(server: McpServer, searchEngine: SearchEngine, config: Config): void {
  server.registerTool(
    "component_search",
    {
      description:
        "Search for Enfusion ScriptComponent descendants — the building blocks you attach to entities in prefabs. Filter by category (character, vehicle, weapon, damage, inventory, ai, ui, editor, camera, sound, general) and/or by event handler name (e.g., 'OnPlayerConnected', 'EOnFrame', 'OnDamage'). Use this when you need to find what component to attach to an entity to achieve specific functionality. " +
        "Alternatively, pass 'entityType' (e.g. 'GenericEntity', 'SCR_ChimeraCharacter', 'Vehicle') to get the components typically found on that entity type, mined from base-game .et prefabs — useful for avoiding incompatible-component mistakes when building a new prefab.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Component name or keyword to search for"),
        category: z
          .enum([
            "character",
            "vehicle",
            "weapon",
            "damage",
            "inventory",
            "ai",
            "ui",
            "editor",
            "camera",
            "sound",
            "general",
            "any",
          ])
          .default("any")
          .describe("Filter by target entity type or functional area"),
        event: z
          .string()
          .optional()
          .describe(
            "Filter by event handler name (e.g., 'EOnFrame', 'OnPlayerConnected', 'OnDamage')"
          ),
        source: z
          .enum(["enfusion", "arma", "all"])
          .default("all")
          .describe("Search enfusion engine API, arma reforger API, or both"),
        limit: z
          .number()
          .min(1)
          .max(50)
          .default(20)
          .describe("Maximum results to return"),
        entityType: z
          .string()
          .optional()
          .describe(
            "Instead of a normal component search, return the components typically attached to this root entity type (e.g. 'GenericEntity', 'SCR_ChimeraCharacter', 'Vehicle'), ranked by how often they co-occur across base-game .et prefabs."
          ),
        refresh: z
          .boolean()
          .default(false)
          .describe("Only used with 'entityType': force a rebuild of the component matrix (clears cache)."),
      },
    },
    async ({ query, category, event, source, limit, entityType, refresh }) => {
      if (entityType) {
        const basePath = resolveGameDataPath(config.gamePath);
        if (!basePath) {
          return {
            content: [
              {
                type: "text",
                text: `Base game not found at ${config.gamePath}. Set ENFUSION_GAME_PATH or ensure Arma Reforger is installed.`,
              },
            ],
            isError: true,
          };
        }
        try {
          const matrix = getComponentMatrix(basePath, config.gamePath, refresh);
          const ranked = getTypicalComponents(matrix, entityType, limit);
          return { content: [{ type: "text", text: formatTypicalComponents(entityType, ranked) }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error building component matrix: ${msg}` }],
            isError: true,
          };
        }
      }

      const results = searchEngine.searchComponents({
        query,
        category,
        event,
        source,
        limit,
      });

      if (results.length === 0) {
        const filters: string[] = [];
        if (query) filters.push(`query "${query}"`);
        if (category !== "any") filters.push(`category "${category}"`);
        if (event) filters.push(`event "${event}"`);
        const filterDesc = filters.length > 0 ? ` matching ${filters.join(", ")}` : "";
        return {
          content: [
            {
              type: "text",
              text: `No components found${filterDesc}. Try broadening your search — use a shorter query, remove the category filter, or search without an event filter.`,
            },
          ],
        };
      }

      const verbose = results.length === 1;
      const header = `Found ${results.length} component${results.length !== 1 ? "s" : ""}:\n`;
      const formatted = results
        .map((r) => formatComponentResult(r, verbose))
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: header + formatted }],
      };
    }
  );
}
