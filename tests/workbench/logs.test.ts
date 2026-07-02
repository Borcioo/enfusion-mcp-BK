import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { findLatestLogDir, readLogTail, parseCompileErrors } from "../../src/workbench/logs.js";

const SAMPLE = readFileSync("tests/fixtures/console-sample.log", "utf-8");

describe("parseCompileErrors", () => {
  it("extracts file, line and message from SCRIPT (E) lines", () => {
    const errors = parseCompileErrors(SAMPLE);
    expect(errors[0]).toEqual({
      file: "Scripts/Game/CentralEconomy/Components/CE_ItemSpawnableComponentSerializer.c",
      line: 10,
      message: "Overloading event 'Serialize' is not allowed",
    });
    // only @"file,line" script errors count as compile errors
    expect(errors.every(e => e.file.endsWith(".c"))).toBe(true);
    expect(errors).toHaveLength(2);
  });

  it("ignores warnings and non-script errors", () => {
    const errors = parseCompileErrors(SAMPLE);
    expect(errors.some(e => e.message.includes("obsolete"))).toBe(false);
    expect(errors.some(e => e.message.includes("GridWidgetSlot"))).toBe(false);
  });

  it("handles real Workbench logs, which use CRLF line endings", () => {
    // Verified live: on-disk console.log files from Workbench are CRLF, not LF.
    // Normalize SAMPLE first in case it was checked out with CRLF line endings
    // (e.g. git core.autocrlf) so we construct exactly one CRLF per line here,
    // not a doubled "\r\r\n".
    const crlf = SAMPLE.replace(/\r/g, "").split("\n").join("\r\n");
    const errors = parseCompileErrors(crlf);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.message).toBe("Overloading event 'Serialize' is not allowed");
  });
});

describe("findLatestLogDir", () => {
  const base = "tests/.tmp-logs";
  beforeAll(() => {
    mkdirSync(join(base, "logs_2026-07-01_10-00-00"), { recursive: true });
    mkdirSync(join(base, "logs_2026-07-03_00-56-02"), { recursive: true });
    mkdirSync(join(base, "not-a-log-dir"), { recursive: true });
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns the lexicographically newest logs_* dir", () => {
    expect(findLatestLogDir(base)).toContain("logs_2026-07-03_00-56-02");
  });
  it("returns null when no logs_* dirs exist", () => {
    expect(findLatestLogDir(join(base, "not-a-log-dir"))).toBeNull();
  });
});

describe("readLogTail", () => {
  const base = "tests/.tmp-tail";
  beforeAll(() => {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "console.log"), SAMPLE);
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("returns last N lines and an endByte cursor for incremental reads", () => {
    const r1 = readLogTail(base, { lines: 3 });
    expect(r1.text.split("\n").filter(Boolean)).toHaveLength(3);
    expect(r1.endByte).toBeGreaterThan(0);
    const r2 = readLogTail(base, { sinceByte: r1.endByte });
    expect(r2.text).toBe("");
  });

  it("applies a filter regex", () => {
    const r = readLogTail(base, { filter: /SCRIPT\s+\(E\)/ });
    expect(r.text.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(3);
    expect(r.text).not.toMatch(/GUI/);
  });
});
