import { describe, it, expect } from "vitest";
import { isAbsolute } from "node:path";
import {
  resolveOutputPath,
  defaultScreenshotDir,
  buildCaptureCommand,
  buildCaptureScript,
  captureScriptPath,
  validatePngFile,
  WORKBENCH_PROCESS_NAME,
} from "../../src/tools/wb-screenshot.js";

describe("resolveOutputPath", () => {
  it("defaults to a timestamped PNG under the screenshot scratch dir", () => {
    const now = new Date("2026-07-03T12:34:56.789Z");
    const result = resolveOutputPath(undefined, now);
    expect(isAbsolute(result)).toBe(true);
    expect(result.startsWith(defaultScreenshotDir())).toBe(true);
    expect(result.endsWith(".png")).toBe(true);
    expect(result).toContain("wb-screenshot-2026-07-03");
  });

  it("produces distinct filenames for distinct timestamps", () => {
    const a = resolveOutputPath(undefined, new Date("2026-07-03T12:00:00.000Z"));
    const b = resolveOutputPath(undefined, new Date("2026-07-03T12:00:01.000Z"));
    expect(a).not.toEqual(b);
  });

  it("resolves a relative outputPath to an absolute path", () => {
    const result = resolveOutputPath("shot.png");
    expect(isAbsolute(result)).toBe(true);
    expect(result.endsWith("shot.png")).toBe(true);
  });

  it("leaves an already-absolute outputPath untouched apart from extension", () => {
    const abs = "C:/tmp/foo.png";
    const result = resolveOutputPath(abs);
    expect(result).toBe(abs);
  });

  it("appends .png when the given outputPath has no .png extension", () => {
    const result = resolveOutputPath("myshot");
    expect(result.endsWith(".png")).toBe(true);
    expect(result.endsWith("myshot.png")).toBe(true);
  });

  it("does not double up .png when already present (case-insensitive)", () => {
    const result = resolveOutputPath("myshot.PNG");
    expect(result.toLowerCase().endsWith(".png")).toBe(true);
    expect(result.toLowerCase().endsWith(".png.png")).toBe(false);
  });

  it("treats an empty-string outputPath the same as omitted", () => {
    const result = resolveOutputPath("   ");
    expect(result.startsWith(defaultScreenshotDir())).toBe(true);
  });
});

describe("buildCaptureCommand", () => {
  it("invokes powershell.exe non-interactively with the script and named params", () => {
    const { command, args } = buildCaptureCommand("C:/scratch/capture-window.ps1", "C:/scratch/out.png");
    expect(command).toBe("powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      "C:/scratch/capture-window.ps1",
      "-ProcessName",
      WORKBENCH_PROCESS_NAME,
      "-OutputPath",
      "C:/scratch/out.png",
    ]);
  });

  it("passes each value as a discrete argv entry (no shell string concatenation)", () => {
    const { args } = buildCaptureCommand("path with spaces\\capture.ps1", "out dir\\shot.png", "SomeProc");
    // Because args is an array passed to spawn (no shell:true), spaces inside a single
    // element never need manual quoting/escaping — verify they survive as one element.
    expect(args).toContain("path with spaces\\capture.ps1");
    expect(args).toContain("out dir\\shot.png");
    expect(args).toContain("SomeProc");
  });

  it("defaults the process name to the Workbench executable", () => {
    const { args } = buildCaptureCommand("s.ps1", "o.png");
    const idx = args.indexOf("-ProcessName");
    expect(args[idx + 1]).toBe(WORKBENCH_PROCESS_NAME);
  });
});

describe("buildCaptureScript", () => {
  it("uses PrintWindow with PW_RENDERFULLCONTENT so GPU-rendered windows capture correctly", () => {
    const script = buildCaptureScript();
    expect(script).toContain("PrintWindow");
    expect(script).toContain("[EmcpWin32]::PrintWindow($hwnd, $hdc, 2)");
  });

  it("declares the expected named parameters", () => {
    const script = buildCaptureScript();
    expect(script).toContain("$ProcessName");
    expect(script).toContain("$OutputPath");
  });

  it("saves as PNG", () => {
    const script = buildCaptureScript();
    expect(script).toContain("[System.Drawing.Imaging.ImageFormat]::Png");
  });
});

describe("captureScriptPath", () => {
  it("is an absolute path under the screenshot scratch dir", () => {
    const p = captureScriptPath();
    expect(isAbsolute(p)).toBe(true);
    expect(p.startsWith(defaultScreenshotDir())).toBe(true);
    expect(p.endsWith(".ps1")).toBe(true);
  });
});

describe("validatePngFile", () => {
  it("reports failure when the file does not exist", () => {
    const result = validatePngFile("C:/definitely/does/not/exist-wb-screenshot.png");
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not exist/);
  });
});
