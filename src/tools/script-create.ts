import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import type { SearchEngine } from "../index/search-engine.js";
import {
  generateScript,
  getScriptModuleFolder,
  getScriptFilename,
  type ScriptType,
} from "../templates/script.js";
import { validateFilename, validateEnforceIdentifier } from "../utils/safe-path.js";
import { formatDryRun } from "../utils/dry-run.js";
import { loadPitfalls, matchPitfalls, formatPitfalls, type PitfallContext } from "../pitfalls/loader.js";

/** Extracts likely engine event names (e.g. "FRAME") referenced by method signatures like "EOnFrame". */
function extractEvents(methods: string[] | undefined): string[] {
  if (!methods) return [];
  const events: string[] = [];
  for (const m of methods) {
    const match = m.match(/\bE?On([A-Z][A-Za-z0-9]*)\s*\(/);
    if (match) events.push(match[1].toUpperCase());
  }
  return events;
}

export function registerScriptCreate(server: McpServer, config: Config, searchEngine?: SearchEngine): void {
  const pitfalls = loadPitfalls(config.dataDir);

  server.registerTool(
    "script_create",
    {
      description:
        "Create a new Enforce Script (.c) file for an Arma Reforger mod. Generates a properly structured script from a template with correct class hierarchy and method stubs. When parentClass is specified and no explicit methods are given, automatically looks up overridable methods from the API index. Supports dryRun to preview without writing.",
      inputSchema: {
        className: z
          .string()
          .min(1)
          .describe(
            "Full class name including prefix (e.g., 'TAG_MyComponent', 'MCM_GameMode')"
          ),
        scriptType: z
          .enum(["modded", "component", "gamemode", "action", "entity", "manager", "basic"])
          .describe(
            "Script template type. 'modded' overrides an existing class. 'component' creates a ScriptComponent. 'gamemode' creates a game mode. 'action' creates an interactive UserAction. 'entity' creates a standalone entity. 'manager' creates a singleton class. 'basic' creates a plain class."
          ),
        parentClass: z
          .string()
          .optional()
          .describe(
            "Parent class to extend. Required for 'modded'. Uses sensible defaults for other types (e.g., ScriptComponent for 'component')."
          ),
        methods: z
          .array(z.string())
          .optional()
          .describe(
            "Method signatures to stub out (e.g., ['void OnGameStart()', 'bool CanPerform(IEntity user)']). Uses default methods per type if omitted."
          ),
        description: z
          .string()
          .optional()
          .describe("Description comment at the top of the file"),
        projectPath: z
          .string()
          .optional()
          .describe("Addon root path. Uses configured default if omitted."),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "Preview what would be created/written without touching disk — returns the target paths and content instead of writing."
          ),
      },
    },
    async ({ className, scriptType, parentClass, methods, description, projectPath, dryRun }) => {
      const basePath = projectPath || config.projectPath;

      try {
        validateFilename(className);
        validateEnforceIdentifier(className);

        // Resolve parent methods from API index if available and no explicit methods given
        let dynamicMethods: string[] | undefined;
        if (!methods && searchEngine && parentClass) {
          const cls = searchEngine.getClass(parentClass);
          if (cls) {
            const allMethods = [
              ...(cls.methods || []),
              ...(cls.protectedMethods || []),
            ];
            const overridable = allMethods.filter((m) =>
              /^(On|EOn|Get|Set|Can|Handle|Do)/.test(m.name) ||
              m.signature.includes("event")
            );
            if (overridable.length > 0) {
              dynamicMethods = overridable.slice(0, 8).map((m) => m.signature);
            }
          }
        }

        const code = generateScript({
          className,
          scriptType: scriptType as ScriptType,
          parentClass,
          methods,
          dynamicMethods,
          description,
        });

        const effectiveMethods = methods || dynamicMethods;
        const pitfallContext: PitfallContext = {
          text: [description, className, parentClass, ...(effectiveMethods || [])]
            .filter(Boolean)
            .join(" "),
          scriptType,
          events: extractEvents(effectiveMethods),
        };
        const matchedPitfalls = matchPitfalls(pitfalls, pitfallContext);
        const pitfallsText = formatPitfalls(matchedPitfalls);
        const pitfallsSuffix = pitfallsText
          ? `\n\n---\n**Common pitfalls relevant to this script:**\n${pitfallsText}`
          : "";

        // If a project path is available, write the file
        if (basePath) {
          const moduleFolder = getScriptModuleFolder(scriptType as ScriptType);
          const filename = getScriptFilename(className);
          const targetDir = resolve(basePath, moduleFolder);
          const targetPath = join(targetDir, filename);

          if (dryRun) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    formatDryRun(
                      [{ path: `${moduleFolder}/${filename}`, content: code }],
                      "Script preview — nothing was written."
                    ) + pitfallsSuffix,
                },
              ],
            };
          }

          mkdirSync(targetDir, { recursive: true });

          if (existsSync(targetPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `File already exists: ${moduleFolder}/${filename}\n\nGenerated code (not written):\n\n\`\`\`c\n${code}\`\`\`${pitfallsSuffix}`,
                },
              ],
            };
          }

          writeFileSync(targetPath, code, "utf-8");

          return {
            content: [
              {
                type: "text",
                text: `Script created: ${moduleFolder}/${filename}\n\n\`\`\`c\n${code}\`\`\`${pitfallsSuffix}`,
              },
            ],
          };
        }

        // No project path — just return the generated code
        return {
          content: [
            {
              type: "text",
              text: `Generated script (no project path configured — not written to disk):\n\n\`\`\`c\n${code}\`\`\`\n\nSet ENFUSION_PROJECT_PATH to write files automatically.${pitfallsSuffix}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error creating script: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}
