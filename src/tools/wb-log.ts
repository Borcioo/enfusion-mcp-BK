import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  findLatestLogDir,
  readLogTail,
  parseCompileErrors,
  candidateLogBases,
  resolveLogsBase,
  formatCompileErrors,
  type CompileError,
} from "../workbench/logs.js";

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
        const { text: rawText } = readLogTail(logDir, { fileName });
        const errors: CompileError[] = parseCompileErrors(rawText);

        if (errors.length === 0) {
          return { content: [{ type: "text" as const, text: `No compile errors found in ${logDir}/${fileName}.` }] };
        }

        const formatted = formatCompileErrors(config, `${logDir}/${fileName}`, errors);
        return { content: [{ type: "text" as const, text: formatted }] };
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
