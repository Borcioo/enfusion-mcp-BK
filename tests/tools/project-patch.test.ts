import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../../src/config.js";
import type { Config } from "../../src/config.js";
import { registerProjectPatch } from "../../src/tools/project-patch.js";

const TEST_DIR = resolve(import.meta.dirname, "../../tmp-test-project-patch");

const config: Config = { ...loadConfig() };

type Handler = (args: any) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

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

function writeTestFile(relPath: string, content: string): string {
  const fullPath = join(TEST_DIR, relPath);
  mkdirSync(resolve(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, content, "utf-8");
  return fullPath;
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("project_patch", () => {
  it("applies a single edit", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const fullPath = writeTestFile("Scripts/Foo.c", "line1\nline2\nline3\n");

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "line2", newString: "line2-edited" }],
    });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(fullPath, "utf-8")).toBe("line1\nline2-edited\nline3\n");
  });

  it("applies multiple sequential edits", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const fullPath = writeTestFile("Scripts/Foo.c", "line1\nline2\nline3\n");

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [
        { oldString: "line1", newString: "line1-edited" },
        { oldString: "line3", newString: "line3-edited" },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(fullPath, "utf-8")).toBe(
      "line1-edited\nline2\nline3-edited\n"
    );
  });

  it("applies edit N to the result of edit N-1 (match created by an earlier edit)", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const fullPath = writeTestFile("Scripts/Chain.c", "alpha\n");

    // "beta" does not exist in the original file — it only appears after edit 1.
    const result = await patch({
      path: "Scripts/Chain.c",
      projectPath: TEST_DIR,
      edits: [
        { oldString: "alpha", newString: "beta" },
        { oldString: "beta", newString: "gamma" },
      ],
    });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(fullPath, "utf-8")).toBe("gamma\n");
  });

  it("fails cleanly (file unchanged) when an earlier edit destroys a later edit's oldString", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "alpha\n";
    const fullPath = writeTestFile("Scripts/Chain2.c", original);

    // Edit 1 removes "alpha"; edit 2 then can't find it → whole patch fails, nothing written.
    const result = await patch({
      path: "Scripts/Chain2.c",
      projectPath: TEST_DIR,
      edits: [
        { oldString: "alpha", newString: "beta" },
        { oldString: "alpha", newString: "gamma" },
      ],
    });

    expect(result.isError).toBeTruthy();
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("errors and leaves file unchanged when oldString is not found", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "line1\nline2\nline3\n";
    const fullPath = writeTestFile("Scripts/Foo.c", original);

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "nope", newString: "whatever" }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/not found/i);
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("errors and leaves file unchanged when oldString is ambiguous (2+ matches) without replaceAll", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "dup\ndup\nline3\n";
    const fullPath = writeTestFile("Scripts/Foo.c", original);

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "dup", newString: "changed" }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/multiple|ambiguous|2 occurrences|more than once/i);
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("replaceAll replaces every occurrence", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const fullPath = writeTestFile("Scripts/Foo.c", "dup\ndup\nline3\ndup\n");

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "dup", newString: "changed", replaceAll: true }],
    });

    expect(result.isError).toBeFalsy();
    expect(readFileSync(fullPath, "utf-8")).toBe(
      "changed\nchanged\nline3\nchanged\n"
    );
  });

  it("errors when oldString === newString", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "line1\nline2\n";
    const fullPath = writeTestFile("Scripts/Foo.c", original);

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "line1", newString: "line1" }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/identical|same/i);
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("errors when edits array is empty", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "line1\nline2\n";
    const fullPath = writeTestFile("Scripts/Foo.c", original);

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/empty|at least one/i);
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("dryRun leaves file unchanged and returns a preview", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const original = "line1\nline2\nline3\n";
    const fullPath = writeTestFile("Scripts/Foo.c", original);

    const result = await patch({
      path: "Scripts/Foo.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "line2", newString: "line2-edited" }],
      dryRun: true,
    });

    expect(result.isError).toBeFalsy();
    const text = getText(result);
    expect(text).toContain("[dry-run]");
    expect(text).toContain("line2-edited");
    expect(readFileSync(fullPath, "utf-8")).toBe(original);
  });

  it("rejects path traversal attempts", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const result = await patch({
      path: "../outside.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "a", newString: "b" }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/traversal|outside/i);
  });

  it("errors when file does not exist", async () => {
    const { server, handlers } = makeFakeServer();
    registerProjectPatch(server, config);
    const patch = handlers.get("project_patch")!;

    const result = await patch({
      path: "Scripts/DoesNotExist.c",
      projectPath: TEST_DIR,
      edits: [{ oldString: "a", newString: "b" }],
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toMatch(/not found/i);
  });
});
