import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { registerApiSearch } from "../../src/tools/api-search.js";
import { MAX_USED_BY_SHOWN } from "../../src/tools/api-search.js";
import type { ClassInfo, GroupInfo, WikiPage } from "../../src/index/types.js";

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

function makeClass(overrides: Partial<ClassInfo> & { name: string }): ClassInfo {
  return {
    name: overrides.name,
    source: "enfusion",
    brief: "",
    description: "",
    parents: [],
    children: [],
    group: "Test",
    sourceFile: "",
    methods: [],
    protectedMethods: [],
    staticMethods: [],
    enums: [],
    properties: [],
    protectedProperties: [],
    docsUrl: "",
    ...overrides,
  };
}

/**
 * Fixture: "Widget" is referenced by 20 distinct "UserNN" classes as a property
 * type, to exercise the cap ("+N more") in the api_search "Used By" section.
 * "LeafClass" is referenced by nothing, to exercise the omitted-section case.
 */
function buildFixtureDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "api-search-usedby-fixture-"));
  const apiDir = join(dir, "api");
  const wikiDir = join(dir, "wiki");
  mkdirSync(apiDir, { recursive: true });
  mkdirSync(wikiDir, { recursive: true });

  const widget = makeClass({ name: "Widget" });
  const leafClass = makeClass({ name: "LeafClass" });

  const users: ClassInfo[] = [];
  for (let i = 1; i <= 20; i++) {
    users.push(
      makeClass({
        name: `User${i}`,
        properties: [{ name: "widget", type: "Widget", description: "" }],
      })
    );
  }

  const enfusionClasses: ClassInfo[] = [widget, leafClass, ...users];
  const armaClasses: ClassInfo[] = [];
  const groups: GroupInfo[] = [];
  const wikiPages: WikiPage[] = [
    { title: "Placeholder", source: "enfusion", content: "placeholder wiki content" },
  ];

  writeFileSync(join(apiDir, "enfusion-classes.json"), JSON.stringify(enfusionClasses));
  writeFileSync(join(apiDir, "arma-classes.json"), JSON.stringify(armaClasses));
  writeFileSync(join(apiDir, "groups.json"), JSON.stringify(groups));
  writeFileSync(join(wikiDir, "pages.json"), JSON.stringify(wikiPages));

  return dir;
}

describe("api_search usedBy section", () => {
  let dataDir: string;
  let engine: SearchEngine;
  let apiSearch: Handler;

  beforeAll(() => {
    dataDir = buildFixtureDataDir();
    engine = new SearchEngine(dataDir);
    const { server, handlers } = makeFakeServer();
    registerApiSearch(server, engine);
    apiSearch = handlers.get("api_search")!;
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("includes a Used By section listing referencing classes", async () => {
    const result = await apiSearch({ query: "Widget", type: "class" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).toContain("### Used By (20)");
    expect(text).toContain("User1");
  });

  it("caps the Used By list and notes how many more exist", async () => {
    const result = await apiSearch({ query: "Widget", type: "class" });
    const text = result.content.map((c) => c.text).join("\n");
    const shownNames = text.match(/^- User\d+$/gm) ?? [];
    expect(shownNames.length).toBe(MAX_USED_BY_SHOWN);
    expect(text).toContain(`... and ${20 - MAX_USED_BY_SHOWN} more`);
  });

  it("omits the Used By section entirely for a class nothing references", async () => {
    const result = await apiSearch({ query: "LeafClass", type: "class" });
    const text = result.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("Used By");
  });
});
