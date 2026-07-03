import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { registerModPlan } from "../../src/tools/mod-plan.js";

const dataDir = resolve(import.meta.dirname, "../../data");
const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-mod-plan");

type Handler = (args: any) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}>;

function makeFakeServer() {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _def: unknown, handler: Handler) => {
      handlers.set(name, handler);
    },
  } as unknown as McpServer;
  return { server, handlers };
}

function getText(result: { content: { type: string; text: string }[] }): string {
  return result.content.map((c) => c.text).join("\n");
}

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...loadConfig(),
    dataDir,
    patternsDir: resolve(dataDir, "patterns"),
    projectPath: TEST_DIR,
    defaultMod: undefined,
    ...overrides,
  };
}

function writeAddon(modName: string): void {
  mkdirSync(join(TEST_DIR, modName), { recursive: true });
  writeFileSync(
    join(TEST_DIR, modName, `${modName}.gproj`),
    `GameProject {\n ID "${modName}"\n GUID "AAAAAAAAAAAAAAAA"\n Dependencies {\n  "58D0FB3206B6F859"\n }\n}`,
    "utf-8"
  );
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("mod_plan", () => {
  it("init creates a valid plan file", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Build a survival game mode",
      phases: [
        { id: "p1", title: "Foundation", tasks: [{ id: "t1", desc: "Scaffold addon" }] },
        { id: "p2", title: "Zombies", tasks: [{ id: "t1", desc: "Add zombie AI" }] },
      ],
    });

    expect(result.isError).toBeUndefined();
    const planPath = join(TEST_DIR, "MyMod", "MODPLAN.json");
    expect(existsSync(planPath)).toBe(true);

    const saved = JSON.parse(readFileSync(planPath, "utf-8"));
    expect(saved.modName).toBe("MyMod");
    expect(saved.goal).toBe("Build a survival game mode");
    expect(saved.phases).toHaveLength(2);
    expect(saved.phases[0].status).toBe("pending");
    expect(saved.phases[0].tasks[0].status).toBe("pending");
  });

  it("init fails if a plan already exists", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "First goal",
      phases: [{ id: "p1", title: "Foundation", tasks: [] }],
    });

    const result = await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Second goal",
      phases: [{ id: "p1", title: "Foundation", tasks: [] }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/already exists/i);

    // Original plan must be untouched.
    const saved = JSON.parse(readFileSync(join(TEST_DIR, "MyMod", "MODPLAN.json"), "utf-8"));
    expect(saved.goal).toBe("First goal");
  });

  it("init supports dryRun and does not write to disk", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Preview goal",
      phases: [{ id: "p1", title: "Foundation", tasks: [] }],
      dryRun: true,
    });

    expect(getText(result)).toContain("[dry-run]");
    expect(existsSync(join(TEST_DIR, "MyMod", "MODPLAN.json"))).toBe(false);
  });

  it("read returns the full plan plus a progress summary", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [
        {
          id: "p1",
          title: "Foundation",
          status: "done",
          tasks: [
            { id: "t1", desc: "Scaffold addon", status: "done" },
            { id: "t2", desc: "Write gproj", status: "done" },
          ],
        },
        {
          id: "p2",
          title: "Zombies",
          tasks: [{ id: "t1", desc: "Add zombie AI" }],
        },
      ],
    });

    const result = await modPlan({ action: "read", modName: "MyMod" });
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as any;
    expect(structured.plan.modName).toBe("MyMod");
    expect(structured.progress.totalPhases).toBe(2);
    expect(structured.progress.donePhases).toBe(1);
    expect(structured.progress.totalTasks).toBe(3);
    expect(structured.progress.doneTasks).toBe(2);
    expect(structured.progress.percent).toBeCloseTo((2 / 3) * 100, 5);
  });

  it("read on a missing plan produces a clear, typed error", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({ action: "read", modName: "MyMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/no plan|not found/i);
  });

  it("read on an invalid plan file produces a clear error, not a crash", async () => {
    writeAddon("MyMod");
    writeFileSync(join(TEST_DIR, "MyMod", "MODPLAN.json"), "{ not valid json", "utf-8");

    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({ action: "read", modName: "MyMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/invalid|parse/i);
  });

  it("update marks a phase and task done and persists to disk", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [
        {
          id: "p1",
          title: "Foundation",
          tasks: [{ id: "t1", desc: "Scaffold addon" }],
        },
      ],
    });

    const result = await modPlan({
      action: "update",
      modName: "MyMod",
      phaseId: "p1",
      taskId: "t1",
      taskStatus: "done",
      phaseStatus: "in_progress",
      notes: "Scaffolding complete, moving on.",
    });

    expect(result.isError).toBeUndefined();

    const saved = JSON.parse(readFileSync(join(TEST_DIR, "MyMod", "MODPLAN.json"), "utf-8"));
    expect(saved.phases[0].status).toBe("in_progress");
    expect(saved.phases[0].tasks[0].status).toBe("done");
    expect(saved.phases[0].notes).toBe("Scaffolding complete, moving on.");
    expect(typeof saved.updatedAt).toBe("string");
  });

  it("update with dryRun does not write to disk but returns what would change", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [{ id: "p1", title: "Foundation", tasks: [{ id: "t1", desc: "Scaffold addon" }] }],
    });

    const before = readFileSync(join(TEST_DIR, "MyMod", "MODPLAN.json"), "utf-8");

    const result = await modPlan({
      action: "update",
      modName: "MyMod",
      phaseId: "p1",
      taskId: "t1",
      taskStatus: "done",
      dryRun: true,
    });

    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toMatch(/done/);

    const after = readFileSync(join(TEST_DIR, "MyMod", "MODPLAN.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("update on an unknown phase/task id returns a clear error", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [{ id: "p1", title: "Foundation", tasks: [{ id: "t1", desc: "Scaffold addon" }] }],
    });

    const result = await modPlan({
      action: "update",
      modName: "MyMod",
      phaseId: "nope",
      phaseStatus: "done",
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/phase.*not found|not found.*phase/i);
  });

  it("next returns the task list of the first non-done phase", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [
        { id: "p1", title: "Foundation", status: "done", tasks: [{ id: "t1", desc: "Scaffold", status: "done" }] },
        { id: "p2", title: "Zombies", tasks: [{ id: "t1", desc: "Add zombie AI" }, { id: "t2", desc: "Add spawner" }] },
        { id: "p3", title: "Polish", tasks: [{ id: "t1", desc: "Balance" }] },
      ],
    });

    const result = await modPlan({ action: "next", modName: "MyMod" });
    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as any;
    expect(structured.phase.id).toBe("p2");
    expect(structured.tasks).toHaveLength(2);
    expect(structured.tasks[0].desc).toBe("Add zombie AI");
  });

  it("next reports clearly when all phases are done", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    await modPlan({
      action: "init",
      modName: "MyMod",
      goal: "Goal",
      phases: [{ id: "p1", title: "Foundation", status: "done", tasks: [] }],
    });

    const result = await modPlan({ action: "next", modName: "MyMod" });
    expect(result.isError).toBeUndefined();
    expect(getText(result)).toMatch(/all phases.*done|no.*pending/i);
  });

  it("next on a missing plan produces a clear error", async () => {
    writeAddon("MyMod");
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({ action: "next", modName: "MyMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/no plan|not found/i);
  });

  it("unknown modName produces a clear error", async () => {
    const { server, handlers } = makeFakeServer();
    registerModPlan(server, makeConfig());
    const modPlan = handlers.get("mod_plan")!;

    const result = await modPlan({ action: "read", modName: "NoSuchMod" });
    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/NoSuchMod/);
  });
});
