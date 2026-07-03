import { describe, it, expect } from "vitest";
import { formatDryRun } from "../../src/utils/dry-run.js";

describe("formatDryRun", () => {
  it("prefixes the response with [dry-run]", () => {
    const out = formatDryRun([{ path: "Scripts/Game/Foo.c" }]);
    expect(out.startsWith("**[dry-run]**")).toBe(true);
  });

  it("lists every planned path", () => {
    const out = formatDryRun([
      { path: "Scripts/Game/Foo.c" },
      { path: "Configs/Bar.conf" },
    ]);
    expect(out).toContain("Scripts/Game/Foo.c");
    expect(out).toContain("Configs/Bar.conf");
  });

  it("includes content for files that have it", () => {
    const out = formatDryRun([
      { path: "Scripts/Game/Foo.c", content: "class Foo {}" },
    ]);
    expect(out).toContain("class Foo {}");
  });

  it("omits a content block for files without content", () => {
    const out = formatDryRun([{ path: "Scripts/Game/Foo.c" }]);
    // No fenced code block should be emitted when there's no content anywhere
    expect(out).not.toContain("```");
  });

  it("accepts a custom title", () => {
    const out = formatDryRun([{ path: "a.c" }], "Addon scaffold preview");
    expect(out).toContain("Addon scaffold preview");
  });
});
