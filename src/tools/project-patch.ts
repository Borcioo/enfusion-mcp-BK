import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { formatDryRun } from "../utils/dry-run.js";
import { validateScriptReferences, formatValidationWarnings } from "../utils/script-validate.js";
import type { SearchEngine } from "../index/search-engine.js";

const editSchema = z.object({
  oldString: z
    .string()
    .describe("Exact text to find and replace. Must match the current file content."),
  newString: z.string().describe("Replacement text."),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      "Replace every occurrence of oldString instead of requiring exactly one match. Default: false."
    ),
});

export function registerProjectPatch(server: McpServer, config: Config, searchEngine?: SearchEngine): void {
  server.registerTool(
    "project_patch",
    {
      description:
        "Apply one or more find-and-replace edits to a file in an Arma Reforger Workbench project, without rewriting the whole file. " +
        "Mirrors Claude Code's Edit tool semantics: each edit's oldString must occur exactly once in the file (unless replaceAll is set), " +
        "or the edit is rejected. All edits are applied atomically — if any edit fails, nothing is written. Supports dryRun to preview. " +
        "When patching a '.c' script, a lightweight cross-reference check runs against the offline API index and appends non-blocking WARNINGS for method calls on known classes that don't resolve (with 'did you mean' suggestions) — the patch always applies regardless of warnings; classes declared locally in the same file are excluded to avoid false positives.",
      inputSchema: {
        path: z
          .string()
          .describe("Relative path within the project to the file to patch (e.g., 'Scripts/Game/MyScript.c')."),
        edits: z
          .array(editSchema)
          .describe("One or more sequential edits to apply. Must contain at least one edit."),
        projectPath: z
          .string()
          .optional()
          .describe("Absolute path to the project directory. Uses configured default if omitted."),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Preview the resulting file content without writing it to disk."),
      },
    },
    async ({ path: inputPath, edits, projectPath, dryRun }) => {
      const basePath = projectPath || config.projectPath;

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

      if (!edits || edits.length === 0) {
        return {
          content: [{ type: "text", text: "project_patch requires a non-empty 'edits' array with at least one edit." }],
          isError: true,
        };
      }

      for (const edit of edits) {
        if (edit.oldString === edit.newString) {
          return {
            content: [
              {
                type: "text",
                text: "Invalid edit: oldString and newString are identical (same text) — no change would be made.",
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const fullPath = validateProjectPath(basePath, inputPath);

        if (!existsSync(fullPath)) {
          return {
            content: [{ type: "text", text: `File not found: ${inputPath}` }],
            isError: true,
          };
        }

        let content = readFileSync(fullPath, "utf-8");

        for (let i = 0; i < edits.length; i++) {
          const { oldString, newString, replaceAll } = edits[i];
          const occurrences = countOccurrences(content, oldString);

          if (occurrences === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: `Edit ${i + 1}: oldString not found in ${inputPath}. No changes were written.\noldString: ${JSON.stringify(
                    oldString
                  )}`,
                },
              ],
              isError: true,
            };
          }

          if (!replaceAll && occurrences > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `Edit ${i + 1}: oldString is ambiguous — found ${occurrences} occurrences in ${inputPath} (expected exactly 1). ` +
                    `Provide more surrounding context, or pass replaceAll: true to replace all occurrences. No changes were written.\noldString: ${JSON.stringify(
                      oldString
                    )}`,
                },
              ],
              isError: true,
            };
          }

          content = replaceAll
            ? content.split(oldString).join(newString)
            : replaceOnce(content, oldString, newString);
        }

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  [{ path: inputPath, content }],
                  "Patch preview — nothing was written."
                ),
              },
            ],
          };
        }

        writeFileSync(fullPath, content, "utf-8");
        const sizeBytes = Buffer.byteLength(content, "utf-8");

        let text = `File patched: ${inputPath} (${edits.length} edit${edits.length === 1 ? "" : "s"} applied, ${sizeBytes} bytes)`;
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
          content: [{ type: "text", text: `Error patching file: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) break;
    count++;
    index = found + needle.length;
  }
  return count;
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const index = haystack.indexOf(needle);
  if (index === -1) return haystack;
  return haystack.slice(0, index) + replacement + haystack.slice(index + needle.length);
}
