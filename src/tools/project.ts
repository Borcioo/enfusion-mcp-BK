import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { relative } from "node:path";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { listDirectory, formatSize } from "../utils/dir-listing.js";
import { formatDryRun } from "../utils/dry-run.js";
import { resolveAddonDir, findGprojDirect, listAddons } from "../utils/game-paths.js";
import { validateScriptReferences, formatValidationWarnings } from "../utils/script-validate.js";
import type { SearchEngine } from "../index/search-engine.js";

export function registerProject(server: McpServer, config: Config, searchEngine?: SearchEngine): void {
  server.registerTool(
    "project",
    {
      description:
        "Browse, read, or write files in an Arma Reforger Workbench project directory. Use action='browse' to list files, action='read' to read a file, action='write' to write a file. action='write' supports dryRun to preview without writing. " +
        "If ENFUSION_PROJECT_PATH points to a multi-mod workspace (a directory containing several addon folders), pass modName to scope any action to a specific addon; action='browse' at the workspace root with no modName lists the available addon folders. " +
        "When writing a '.c' script, a lightweight cross-reference check runs against the offline API index and appends non-blocking WARNINGS for method calls on known classes that don't resolve (with 'did you mean' suggestions) — the write always succeeds regardless of warnings; classes declared locally in the same file are excluded to avoid false positives.",
      inputSchema: {
        action: z
          .enum(["browse", "read", "write"])
          .describe("Operation to perform: browse (list files), read (read a file), write (write a file)"),
        path: z
          .string()
          .optional()
          .describe(
            "(browse) Subdirectory to list within the project (e.g., 'Scripts/Game', 'Prefabs'). Omit for project root. " +
            "(read) Relative path within the project (e.g., 'Scripts/Game/MyScript.c', 'MyMod.gproj'). " +
            "(write) Relative path within the project (e.g., 'Scripts/Game/MyScript.c')."
          ),
        pattern: z
          .string()
          .optional()
          .describe("(browse) File extension filter (e.g., '*.c', '*.et')"),
        content: z
          .string()
          .optional()
          .describe("(write) File content to write"),
        createDirectories: z
          .boolean()
          .optional()
          .describe(
            "(write) Create parent directories if they don't exist. Default: true."
          ),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the project directory. Uses configured default if omitted."
          ),
        modName: z
          .string()
          .optional()
          .describe(
            "Addon folder name under ENFUSION_PROJECT_PATH when it points to a multi-mod workspace " +
            "(e.g., 'MyMod'). Scopes browse/read/write into that addon. If omitted, falls back to the " +
            "configured default mod (ENFUSION_DEFAULT_MOD), or the configured project path itself. " +
            "Ignored when 'projectPath' is explicitly provided. " +
            "When action='browse' is called at the workspace root with no modName and no path, " +
            "the available addon folders are listed instead of a plain file listing."
          ),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "(write) Preview what would be written without touching disk — returns the target path and content instead of writing. No effect on browse/read."
          ),
      },
    },
    async ({ action, path: inputPath, pattern, content, createDirectories, projectPath, modName, dryRun }) => {
      // Resolve the base path this call operates on.
      // Precedence: explicit projectPath override > modName (multi-mod workspace) >
      // configured defaultMod > configured projectPath (original single-mod behavior).
      let basePath: string;
      if (projectPath) {
        basePath = projectPath;
      } else if (modName) {
        const addonDir = resolveAddonDir(config.projectPath, modName);
        if (!addonDir) {
          return {
            content: [
              {
                type: "text",
                text: `Could not find addon directory. '${modName}' not found under ${config.projectPath}. Provide modName matching the addon folder name.`,
              },
            ],
            isError: true,
          };
        }
        basePath = addonDir;
      } else if (config.defaultMod) {
        basePath = resolveAddonDir(config.projectPath, config.defaultMod) ?? config.projectPath;
      } else {
        // Deliberate exception: when neither modName nor defaultMod is set, this falls
        // through to the raw config.projectPath rather than auto-detecting the first
        // .gproj addon (which is what game-duplicate.ts / wb-entity-duplicate.ts do via
        // resolveAddonDir(projectPath) with no modName). That auto-detect scans child
        // directories for a .gproj, which would break the legacy "single addon lives
        // directly at projectPath, no multi-mod subfolders" layout. Keeping the plain
        // fallback here preserves backward compatibility for that layout.
        basePath = config.projectPath;
      }

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (action === "browse") {
        try {
          const subPath = inputPath ?? "";
          const isRootBrowse = !subPath || subPath === ".";

          // Multi-mod workspace discovery: browsing the root with no modName/projectPath
          // override lists the addon folders found under the workspace instead of a plain
          // file listing — but only when basePath is still the raw, unscoped workspace root
          // (i.e. defaultMod/modName did NOT already resolve basePath to a specific addon).
          // We gate on `basePath === config.projectPath` rather than re-deriving "is this an
          // addon" via findGprojDirect on the already-resolved basePath: for nested-source
          // layouts (e.g. Central-Economy/source/addon.gproj resolved via defaultMod),
          // findGprojDirect(basePath) wrongly returns null even though basePath IS a real,
          // already-resolved addon — which used to cause a bogus fall-through to the addon list.
          // The findGprojDirect(basePath) check is still needed for the legacy case where a
          // single addon's .gproj sits directly at the (unscoped) workspace root with no
          // defaultMod configured — that must keep browsing the root itself, not list addons.
          const isUnscopedWorkspaceRoot = basePath === config.projectPath;
          if (isRootBrowse && !modName && !projectPath && isUnscopedWorkspaceRoot && !findGprojDirect(basePath)) {
            const addons = listAddons(config.projectPath);
            if (addons.length > 0) {
              const lines: string[] = [];
              lines.push(`Workspace: ${config.projectPath}`);
              lines.push(`Addons found: ${addons.length}`);
              lines.push("");
              for (const addon of addons) {
                const tag = addon.hasGproj ? "[addon]" : "[no .gproj]";
                lines.push(`  ${addon.name}/  ${tag}`);
              }
              lines.push("");
              lines.push("Pass modName to browse/read/write within a specific addon.");
              return { content: [{ type: "text", text: lines.join("\n") }] };
            }
          }

          const targetPath = subPath
            ? validateProjectPath(basePath, subPath)
            : basePath;

          const entries = listDirectory(targetPath, pattern);
          const relPath = relative(basePath, targetPath) || ".";

          const lines: string[] = [];
          lines.push(`Project: ${basePath}`);
          lines.push(`Path: ${relPath === "." ? "(root)" : relPath}`);
          lines.push("");

          let fileCount = 0;
          let dirCount = 0;

          for (const entry of entries) {
            if (entry.isDirectory) {
              lines.push(`  ${entry.name}/`);
              dirCount++;
            } else {
              const typeTag = entry.type ? `[${entry.type}]` : "";
              const sizeStr = formatSize(entry.size);
              lines.push(
                `  ${entry.name.padEnd(40)} ${typeTag.padEnd(12)} ${sizeStr}`
              );
              fileCount++;
            }
          }

          lines.push("");
          lines.push(`Total: ${fileCount} files, ${dirCount} directories`);

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error browsing project: ${msg}` }],
            isError: true,
          };
        }
      }

      if (action === "read") {
        if (!inputPath) {
          return {
            content: [{ type: "text", text: "action='read' requires a 'path' parameter." }],
            isError: true,
          };
        }

        try {
          const fullPath = validateProjectPath(basePath, inputPath);

          if (!existsSync(fullPath)) {
            return {
              content: [{ type: "text", text: `File not found: ${inputPath}` }],
              isError: true,
            };
          }

          const fileContent = readFileSync(fullPath, "utf-8");
          return {
            content: [{ type: "text", text: fileContent }],
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error reading file: ${msg}` }],
            isError: true,
          };
        }
      }

      if (action === "write") {
        if (!inputPath) {
          return {
            content: [{ type: "text", text: "action='write' requires a 'path' parameter." }],
            isError: true,
          };
        }
        if (content === undefined) {
          return {
            content: [{ type: "text", text: "action='write' requires a 'content' parameter." }],
            isError: true,
          };
        }

        try {
          const fullPath = validateProjectPath(basePath, inputPath);
          const shouldCreateDirs = createDirectories !== false;

          if (dryRun) {
            return {
              content: [
                {
                  type: "text",
                  text: formatDryRun(
                    [{ path: inputPath, content }],
                    "Write preview — nothing was written."
                  ),
                },
              ],
            };
          }

          if (shouldCreateDirs) {
            mkdirSync(dirname(fullPath), { recursive: true });
          }

          writeFileSync(fullPath, content, "utf-8");
          const sizeBytes = Buffer.byteLength(content, "utf-8");

          let text = `File written: ${inputPath} (${sizeBytes} bytes)`;
          if (searchEngine && inputPath.toLowerCase().endsWith(".c")) {
            const warnings = validateScriptReferences(searchEngine, content);
            text += formatValidationWarnings(warnings);
          }

          return {
            content: [
              {
                type: "text",
                text,
              },
            ],
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error writing file: ${msg}` }],
            isError: true,
          };
        }
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        isError: true,
      };
    }
  );
}
