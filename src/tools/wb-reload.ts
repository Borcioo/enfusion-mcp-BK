import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";
import {
  findLatestLogDir,
  readLogTail,
  resolveLogsBase,
  collectNewCompileErrors,
  formatCompileErrors,
} from "../workbench/logs.js";

/** How long to poll the console log for growth after triggering a reload. */
const POLL_TIMEOUT_MS = 5000;
/** Interval between polls. */
const POLL_INTERVAL_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll the console log until it grows past `beforeByte` or the timeout elapses.
 * Returns the latest endByte observed (equal to `beforeByte` if nothing grew).
 */
async function waitForLogGrowth(logDir: string, beforeByte: number): Promise<number> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastEndByte = beforeByte;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const { endByte } = readLogTail(logDir, { sinceByte: beforeByte });
    lastEndByte = endByte;
    if (endByte > beforeByte) return endByte;
  }
  return lastEndByte;
}

export function registerWbReload(server: McpServer, client: WorkbenchClient, config: Config): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reload scripts or plugins in the Workbench. Use after editing .c script files or Workbench plugins to pick up changes without restarting. " +
        "Automatically waits for the Workbench console log to grow after the reload and surfaces any compile errors " +
        "(file:line, message, and ±5 lines of source context) directly in the response — no need to check the console manually.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      // Capture the log cursor before triggering the reload so we only look at
      // bytes written as a result of this reload, not stale errors from before.
      const logsBase = resolveLogsBase(config);
      const logDir = logsBase ? findLatestLogDir(logsBase) : null;
      const beforeByte = logDir ? readLogTail(logDir, {}).endByte : 0;

      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });

        let errorSection = "";
        if (logDir) {
          const afterByte = await waitForLogGrowth(logDir, beforeByte);
          const errors = collectNewCompileErrors(logDir, beforeByte);
          if (errors.length > 0) {
            errorSection = "\n\n" + formatCompileErrors(config, `${logDir}/console.log`, errors);
          } else if (afterByte === beforeByte) {
            errorSection = `\n\n(No new log activity observed within ${POLL_TIMEOUT_MS / 1000}s — could not confirm compile status.)`;
          }
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${errorSection}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
