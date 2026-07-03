import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { PatternLibrary } from "../../src/patterns/loader.js";
import { registerCreateModPrompt } from "../../src/prompts/create-mod.js";

type PromptHandler = (args: { description: string }) => {
  messages: Array<{ role: string; content: { type: string; text: string } }>;
};

function makeFakeServer() {
  let handler: PromptHandler | undefined;
  const server = {
    registerPrompt: (_name: string, _def: unknown, h: PromptHandler) => {
      handler = h;
    },
  } as unknown as McpServer;
  return { server, getHandler: () => handler! };
}

describe("create-mod prompt — pattern example injection", () => {
  it("injects verified code examples into the prompt text when patterns have them", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "create-mod-prompt-"));
    try {
      writeFileSync(
        join(tmpDir, "demo-pattern.json"),
        JSON.stringify({
          name: "Demo Pattern",
          description: "A pattern used for prompt injection testing",
          tags: ["demo"],
          scripts: [],
          prefabs: [],
          configs: [],
          instructions: "instr",
          codeExamples: [
            {
              title: "Demo Snippet",
              description: "Demonstrates the injected snippet.",
              code: "void DemoMethod()\n{\n  Print(\"demo\");\n}",
            },
          ],
        }),
        "utf-8"
      );

      const patterns = new PatternLibrary(tmpDir);
      const { server, getHandler } = makeFakeServer();
      registerCreateModPrompt(server, patterns);

      const result = getHandler()({ description: "a test mod" });
      const text = result.messages[0].content.text;

      expect(text).toContain("Demo Pattern");
      expect(text).toContain("Demo Snippet");
      expect(text).toContain("Demonstrates the injected snippet.");
      expect(text).toContain("DemoMethod");
      expect(text).toContain("Verified Example Snippets");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("omits the examples section when no pattern has codeExamples", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "create-mod-prompt-empty-"));
    try {
      writeFileSync(
        join(tmpDir, "no-examples.json"),
        JSON.stringify({
          name: "No Examples",
          description: "desc",
          tags: [],
          scripts: [],
          prefabs: [],
          configs: [],
          instructions: "instr",
        }),
        "utf-8"
      );

      const patterns = new PatternLibrary(tmpDir);
      const { server, getHandler } = makeFakeServer();
      registerCreateModPrompt(server, patterns);

      const result = getHandler()({ description: "a test mod" });
      const text = result.messages[0].content.text;

      expect(text).not.toContain("Verified Example Snippets");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
