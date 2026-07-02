import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import { findLatestLogDir, readLogTail, parseCompileErrors, type CompileError } from "../workbench/logs.js";
import { logger } from "../utils/logger.js";

/** Candidate parent directories that hold logs_<timestamp> subfolders. */
function candidateLogBases(config: Config): string[] {
  const candidates: string[] = [];
  if (config.workbenchProfileDir) candidates.push(config.workbenchProfileDir);
  candidates.push(
    join(homedir(), "Documents", "My Games", "ArmaReforgerWorkbench", "logs"),
    join(homedir(), "OneDrive", "Dokumenty", "My Games", "ArmaReforgerWorkbench", "logs"),
    join(homedir(), "OneDrive", "Documents", "My Games", "ArmaReforgerWorkbench", "logs")
  );
  return candidates;
}

/** Resolve the first existing candidate logs base directory. */
function resolveLogsBase(config: Config): string | null {
  for (const candidate of candidateLogBases(config)) {
    if (existsSync(candidate)) {
      logger.debug(`wb_log: using logs base dir ${candidate}`);
      return candidate;
    }
  }
  return null;
}

/** Locate a script source file on disk to pull context lines around a compile error. */
function findSourceFile(config: Config, relFile: string): string | null {
  const roots: string[] = [];
  if (config.defaultMod) roots.push(join(config.projectPath, config.defaultMod));
  roots.push(config.projectPath);

  for (const root of roots) {
    const candidate = join(root, relFile);
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to scanning immediate subdirectories of projectPath (addon folders)
  try {
    for (const entry of readdirSync(config.projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(config.projectPath, entry.name, relFile);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // projectPath may not exist / be readable — ignore
  }

  return null;
}

/** Read up to `radius` lines of context before/after the 1-indexed error line. */
function readContext(filePath: string, line: number, radius = 5): string | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNo = start + i + 1;
        const marker = lineNo === line ? ">>" : "  ";
        return `${marker} ${lineNo}: ${l}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

export function registerWbLog(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_log",
    {
      description:
        "Read Workbench console logs from disk. Works even when NET API handlers fail to compile.",
      inputSchema: {
        lines: z.number().min(1).max(1000).default(100).describe("Number of trailing log lines to return"),
        filter: z.string().optional().describe("Regex to filter log lines"),
        errorsOnly: z
          .boolean()
          .default(false)
          .describe("Return only parsed SCRIPT compile errors, with ±5 lines of source context"),
        file: z.enum(["console", "script"]).default("console").describe("Which log file to read"),
      },
    },
    async ({ lines, filter, errorsOnly, file }) => {
      const base = resolveLogsBase(config);
      if (!base) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "Could not find a Workbench logs directory. Tried: " +
                candidateLogBases(config).join(", ") +
                ". Set workbenchProfileDir in config or ENFUSION_WORKBENCH_PROFILE_DIR.",
            },
          ],
          isError: true,
        };
      }

      const logDir = findLatestLogDir(base);
      if (!logDir) {
        return {
          content: [
            { type: "text" as const, text: `No logs_* directories found under ${base}.` },
          ],
          isError: true,
        };
      }

      const fileName = file === "script" ? "script.log" : "console.log";
      let filterRe: RegExp | undefined;
      if (filter) {
        try {
          filterRe = new RegExp(filter);
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Invalid filter regex: ${e instanceof Error ? e.message : String(e)}` }],
            isError: true,
          };
        }
      }

      if (errorsOnly) {
        const { text } = readLogTail(logDir, { fileName });
        const errors: CompileError[] = parseCompileErrors(text);

        if (errors.length === 0) {
          return { content: [{ type: "text" as const, text: `No compile errors found in ${logDir}/${fileName}.` }] };
        }

        const parts: string[] = [`**Compile Errors** (${logDir}/${fileName})\n`];
        for (const err of errors) {
          parts.push(`- ${err.file}:${err.line}: ${err.message}`);
          const sourcePath = findSourceFile(config, err.file);
          if (sourcePath) {
            const context = readContext(sourcePath, err.line);
            if (context) parts.push("```\n" + context + "\n```");
          } else {
            parts.push(`  (source file not found for context: ${err.file})`);
          }
        }
        return { content: [{ type: "text" as const, text: parts.join("\n") }] };
      }

      const { text } = readLogTail(logDir, { lines, filter: filterRe, fileName });
      return {
        content: [
          {
            type: "text" as const,
            text: `**${fileName}** (${logDir})\n\n${text || "(no matching lines)"}`,
          },
        ],
      };
    }
  );
}
