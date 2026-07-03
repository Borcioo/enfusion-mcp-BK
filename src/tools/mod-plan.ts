import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { resolveAddonDir } from "../utils/game-paths.js";
import { formatDryRun } from "../utils/dry-run.js";

// ─── plan schema ────────────────────────────────────────────────────────────

const TaskStatus = z.enum(["pending", "in_progress", "done"]);
const PhaseStatus = z.enum(["pending", "in_progress", "done"]);

export interface ModPlanTask {
  id: string;
  desc: string;
  status: "pending" | "in_progress" | "done";
  files?: string[];
}

export interface ModPlanPhase {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "done";
  tasks: ModPlanTask[];
  notes?: string;
}

export interface ModPlan {
  modName: string;
  goal: string;
  architecture?: string;
  phases: ModPlanPhase[];
  updatedAt?: string;
}

const TaskInputSchema = z.object({
  id: z.string().min(1),
  desc: z.string().min(1),
  status: TaskStatus.optional(),
  files: z.array(z.string()).optional(),
});

const PhaseInputSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: PhaseStatus.optional(),
  tasks: z.array(TaskInputSchema).default([]),
  notes: z.string().optional(),
});

/** Normalize an `init`-supplied phase list into a fully-populated ModPlan.phases. */
function normalizePhases(phases: z.infer<typeof PhaseInputSchema>[]): ModPlanPhase[] {
  return phases.map((p) => ({
    id: p.id,
    title: p.title,
    status: p.status ?? "pending",
    notes: p.notes,
    tasks: p.tasks.map((t) => ({
      id: t.id,
      desc: t.desc,
      status: t.status ?? "pending",
      files: t.files,
    })),
  }));
}

// ─── progress summary ───────────────────────────────────────────────────────

export interface PlanProgress {
  totalPhases: number;
  donePhases: number;
  totalTasks: number;
  doneTasks: number;
  percent: number;
}

export function computeProgress(plan: ModPlan): PlanProgress {
  const totalPhases = plan.phases.length;
  const donePhases = plan.phases.filter((p) => p.status === "done").length;
  const totalTasks = plan.phases.reduce((sum, p) => sum + p.tasks.length, 0);
  const doneTasks = plan.phases.reduce(
    (sum, p) => sum + p.tasks.filter((t) => t.status === "done").length,
    0
  );
  const percent = totalTasks === 0 ? 0 : (doneTasks / totalTasks) * 100;
  return { totalPhases, donePhases, totalTasks, doneTasks, percent };
}

// ─── plan file helpers ──────────────────────────────────────────────────────

const PLAN_FILENAME = "MODPLAN.json";

function planPath(addonDir: string): string {
  return join(addonDir, PLAN_FILENAME);
}

type LoadResult = { plan: ModPlan } | { error: string };

function loadPlan(addonDir: string): LoadResult {
  const path = planPath(addonDir);
  if (!existsSync(path)) {
    return { error: `No plan found — ${PLAN_FILENAME} does not exist at ${path}. Use action='init' to create one.` };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Failed to read ${PLAN_FILENAME}: ${msg}` };
  }
  try {
    const parsed = JSON.parse(raw) as ModPlan;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.phases)) {
      return { error: `Invalid plan file at ${path}: missing or malformed "phases" array.` };
    }
    return { plan: parsed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Invalid plan file at ${path}: failed to parse JSON — ${msg}` };
  }
}

function savePlan(addonDir: string, plan: ModPlan): void {
  mkdirSync(addonDir, { recursive: true });
  writeFileSync(planPath(addonDir), JSON.stringify(plan, null, 2), "utf-8");
}

// ─── registerModPlan ────────────────────────────────────────────────────────

export function registerModPlan(server: McpServer, config: Config): void {
  server.registerTool(
    "mod_plan",
    {
      description:
        "Manage a structured MODPLAN.json cross-session handoff document for a mod (replaces freeform MODPLAN.md). " +
        "action='init' creates a new plan (fails if one already exists), action='read' returns the full plan plus a computed progress summary, " +
        "action='update' marks a phase and/or task status and can add/replace a phase's notes, action='next' returns the task list of the first " +
        "phase that is not yet 'done' (in array order). 'init' and 'update' support dryRun to preview without writing.",
      inputSchema: {
        action: z
          .enum(["init", "read", "update", "next"])
          .describe(
            "Action to perform: 'init' creates a new plan, 'read' returns the plan + progress, " +
            "'update' marks phase/task status and notes, 'next' returns the next incomplete phase's tasks."
          ),
        modName: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Addon folder name under ENFUSION_PROJECT_PATH when it points to a multi-mod workspace. " +
            "If omitted, falls back to the configured default mod (ENFUSION_DEFAULT_MOD), or the configured project path itself."
          ),
        dryRun: z
          .boolean()
          .default(false)
          .describe("(init/update) Preview what would be written without touching disk."),

        // ── init params ───────────────────────────────────────────────────────
        goal: z.string().optional().describe("(init) 1-2 sentence description of the mod's overall goal/vision."),
        architecture: z.string().optional().describe("(init) Architecture notes — class prefix, key design decisions, dependencies between systems."),
        phases: z
          .array(PhaseInputSchema)
          .optional()
          .describe(
            "(init) Initial phase list. Each phase: { id, title, status?, tasks: [{ id, desc, status?, files? }], notes? }. " +
            "status/task-status default to 'pending' when omitted."
          ),

        // ── update params ─────────────────────────────────────────────────────
        phaseId: z.string().optional().describe("(update) ID of the phase to update."),
        phaseStatus: PhaseStatus.optional().describe("(update) New status for the phase identified by phaseId."),
        taskId: z.string().optional().describe("(update) ID of the task (within phaseId) to update."),
        taskStatus: TaskStatus.optional().describe("(update) New status for the task identified by taskId within phaseId."),
        notes: z.string().optional().describe("(update) Replace the notes field of the phase identified by phaseId."),
      },
    },
    async ({ action, modName, dryRun, goal, architecture, phases, phaseId, phaseStatus, taskId, taskStatus, notes }) => {
      // ── resolve addon directory ─────────────────────────────────────────────
      // Mirrors mod.ts action=validate resolution: explicit modName > configured
      // defaultMod > configured projectPath itself (legacy single-addon layout).
      let addonDir: string;
      if (modName) {
        const resolved = resolveAddonDir(config.projectPath, modName);
        if (!resolved) {
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
        addonDir = resolved;
      } else if (config.defaultMod) {
        addonDir = resolveAddonDir(config.projectPath, config.defaultMod) ?? config.projectPath;
      } else {
        addonDir = config.projectPath;
      }

      if (!addonDir) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide modName.",
            },
          ],
          isError: true,
        };
      }

      // ── init ─────────────────────────────────────────────────────────────────
      if (action === "init") {
        if (!goal) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'init': goal" }],
            isError: true,
          };
        }
        if (!phases || phases.length === 0) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'init': phases (must be non-empty)" }],
            isError: true,
          };
        }

        const path = planPath(addonDir);
        if (existsSync(path)) {
          return {
            content: [
              {
                type: "text",
                text: `A plan already exists at ${path}. Use action='update' to modify it, or delete the file first if you intend to overwrite it.`,
              },
            ],
            isError: true,
          };
        }

        const plan: ModPlan = {
          modName: modName ?? (config.defaultMod || addonDir.split(/[\\/]/).pop() || "mod"),
          goal,
          architecture,
          phases: normalizePhases(phases),
          updatedAt: new Date().toISOString(),
        };

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  [{ path, content: JSON.stringify(plan, null, 2) }],
                  `MODPLAN.json preview for "${plan.modName}" — nothing was written.`
                ),
              },
            ],
          };
        }

        savePlan(addonDir, plan);

        return {
          content: [
            {
              type: "text",
              text: `Plan created: ${path}\n\nPhases: ${plan.phases.length}, tasks: ${plan.phases.reduce((s, p) => s + p.tasks.length, 0)}`,
            },
          ],
          structuredContent: { plan },
        };
      }

      // ── read ─────────────────────────────────────────────────────────────────
      if (action === "read") {
        const result = loadPlan(addonDir);
        if ("error" in result) {
          return { content: [{ type: "text", text: result.error }], isError: true };
        }
        const progress = computeProgress(result.plan);
        const lines: string[] = [];
        lines.push(`## Mod Plan: ${result.plan.modName}`);
        lines.push("");
        lines.push(result.plan.goal);
        if (result.plan.architecture) {
          lines.push("");
          lines.push(`**Architecture:** ${result.plan.architecture}`);
        }
        lines.push("");
        lines.push(
          `**Progress:** ${progress.donePhases}/${progress.totalPhases} phases done, ` +
          `${progress.doneTasks}/${progress.totalTasks} tasks done (${progress.percent.toFixed(1)}%)`
        );
        lines.push("");
        for (const p of result.plan.phases) {
          lines.push(`### [${p.status}] ${p.id}: ${p.title}`);
          for (const t of p.tasks) {
            lines.push(`- [${t.status}] ${t.id}: ${t.desc}`);
          }
          if (p.notes) lines.push(`  Notes: ${p.notes}`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          structuredContent: { plan: result.plan, progress },
        };
      }

      // ── update ───────────────────────────────────────────────────────────────
      if (action === "update") {
        const result = loadPlan(addonDir);
        if ("error" in result) {
          return { content: [{ type: "text", text: result.error }], isError: true };
        }
        const plan = result.plan;

        if (!phaseId) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'update': phaseId" }],
            isError: true,
          };
        }

        const phase = plan.phases.find((p) => p.id === phaseId);
        if (!phase) {
          return {
            content: [{ type: "text", text: `Phase not found: '${phaseId}'. Known phase IDs: ${plan.phases.map((p) => p.id).join(", ") || "(none)"}` }],
            isError: true,
          };
        }

        const changes: string[] = [];

        if (taskId) {
          const task = phase.tasks.find((t) => t.id === taskId);
          if (!task) {
            return {
              content: [{ type: "text", text: `Task not found: '${taskId}' in phase '${phaseId}'. Known task IDs: ${phase.tasks.map((t) => t.id).join(", ") || "(none)"}` }],
              isError: true,
            };
          }
          if (taskStatus) {
            task.status = taskStatus;
            changes.push(`task ${taskId} -> ${taskStatus}`);
          }
        }

        if (phaseStatus) {
          phase.status = phaseStatus;
          changes.push(`phase ${phaseId} -> ${phaseStatus}`);
        }

        if (notes !== undefined) {
          phase.notes = notes;
          changes.push(`phase ${phaseId} notes updated`);
        }

        if (changes.length === 0) {
          return {
            content: [{ type: "text", text: "No changes specified — provide phaseStatus, taskId+taskStatus, and/or notes." }],
            isError: true,
          };
        }

        plan.updatedAt = new Date().toISOString();

        if (dryRun) {
          return {
            content: [
              {
                type: "text",
                text: formatDryRun(
                  [{ path: planPath(addonDir), content: JSON.stringify(plan, null, 2) }],
                  `Update preview — would apply: ${changes.join(", ")}. Nothing was written.`
                ),
              },
            ],
            structuredContent: { plan, changes },
          };
        }

        savePlan(addonDir, plan);

        return {
          content: [{ type: "text", text: `Plan updated: ${changes.join(", ")}` }],
          structuredContent: { plan, changes },
        };
      }

      // ── next ─────────────────────────────────────────────────────────────────
      // action === "next"
      const result = loadPlan(addonDir);
      if ("error" in result) {
        return { content: [{ type: "text", text: result.error }], isError: true };
      }

      const nextPhase = result.plan.phases.find((p) => p.status !== "done");
      if (!nextPhase) {
        return {
          content: [{ type: "text", text: `All phases are done (${result.plan.phases.length}/${result.plan.phases.length}). No pending work remains.` }],
          structuredContent: { phase: null, tasks: [] },
        };
      }

      const lines: string[] = [];
      lines.push(`## Next phase: [${nextPhase.status}] ${nextPhase.id}: ${nextPhase.title}`);
      if (nextPhase.notes) lines.push(`Notes: ${nextPhase.notes}`);
      lines.push("");
      lines.push("### Tasks");
      for (const t of nextPhase.tasks) {
        lines.push(`- [${t.status}] ${t.id}: ${t.desc}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { phase: nextPhase, tasks: nextPhase.tasks },
      };
    }
  );
}
