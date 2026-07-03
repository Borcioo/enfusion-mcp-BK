import { mkdirSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readLogTail, collectNewCompileErrors } from "../../src/workbench/logs.js";

// Reuse a fixture line from Task 1's tests (tests/fixtures/console-sample.log).
const ERROR_LINE =
  '   SCRIPT    (E): @"Scripts/Game/CentralEconomy/Components/CE_ItemSpawnableComponentSerializer.c,10": Overloading event \'Serialize\' is not allowed\n';

describe("collectNewCompileErrors", () => {
  const base = "tests/.tmp-reload-logs";

  beforeAll(() => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "console.log"), "  SCRIPT       : Compiling Game scripts\n");
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns an empty list when no new errors were appended after the cursor", () => {
    const { endByte } = readLogTail(base, {});
    const errors = collectNewCompileErrors(base, endByte);
    expect(errors).toEqual([]);
  });

  it("returns newly-appended compile errors written after the cursor", () => {
    const { endByte: beforeByte } = readLogTail(base, {});
    appendFileSync(join(base, "console.log"), ERROR_LINE);

    const errors = collectNewCompileErrors(base, beforeByte);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual({
      file: "Scripts/Game/CentralEconomy/Components/CE_ItemSpawnableComponentSerializer.c",
      line: 10,
      message: "Overloading event 'Serialize' is not allowed",
    });
  });
});
