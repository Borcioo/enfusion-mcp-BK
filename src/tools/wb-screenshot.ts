/**
 * wb_screenshot — capture the running Workbench window as a PNG so an agent
 * can visually verify its work.
 *
 * Implementation note (path choice): the Enfusion API exposes
 * `System.MakeScreenshot(path)` (proto, BMP output) which would let an
 * Enforce Script handler capture the in-editor viewport directly. That
 * requires a *new* WorkbenchGame-module handler (`EMCP_WB_Screenshot.c`),
 * and WorkbenchGame-module handlers only load on a full Workbench restart
 * (unlike Game-module handlers, which hot-reload). That path could not be
 * live-verified in this working session, so this tool instead captures the
 * whole Workbench window from the OS side via PowerShell + PrintWindow —
 * no handler, no restart, fully verifiable now. Trade-off: it captures the
 * entire window (menus, panels, toolbars) rather than an isolated viewport
 * render, and the process must have a visible top-level window.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Process name (no .exe) whose main window we capture. Matches WORKBENCH_EXE in workbench/client.ts. */
export const WORKBENCH_PROCESS_NAME = "ArmaReforgerWorkbenchSteamDiag";

/** Default directory for screenshots when no outputPath is given: OS temp dir. */
export function defaultScreenshotDir(): string {
  return join(tmpdir(), "enfusion-mcp-screenshots");
}

/**
 * Resolve the absolute PNG output path for a capture.
 * - If outputPath is given, it is resolved to an absolute path (relative
 *   paths are resolved against cwd) and forced to end in .png.
 * - If omitted, a timestamped file is created under defaultScreenshotDir().
 */
export function resolveOutputPath(outputPath?: string, now: Date = new Date()): string {
  if (outputPath && outputPath.trim().length > 0) {
    const abs = isAbsolute(outputPath) ? outputPath : resolve(outputPath);
    return abs.toLowerCase().endsWith(".png") ? abs : `${abs}.png`;
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return join(defaultScreenshotDir(), `wb-screenshot-${stamp}.png`);
}

/** Build the PowerShell (PrintWindow-based) capture script contents. */
export function buildCaptureScript(): string {
  return `param(
  [Parameter(Mandatory=$true)][string]$ProcessName,
  [Parameter(Mandatory=$true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class EmcpWin32 {
    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

$proc = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $proc) {
    Write-Error "Process '$ProcessName' not found or has no visible main window."
    exit 1
}

$hwnd = $proc.MainWindowHandle

if ([EmcpWin32]::IsIconic($hwnd)) {
    [EmcpWin32]::ShowWindow($hwnd, 9) | Out-Null # SW_RESTORE
    Start-Sleep -Milliseconds 300
}

$rect = New-Object EmcpWin32+RECT
[EmcpWin32]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top

if ($width -le 0 -or $height -le 0) {
    Write-Error "Invalid window dimensions: $width x $height"
    exit 1
}

$bmp = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $graphics.GetHdc()

$success = [EmcpWin32]::PrintWindow($hwnd, $hdc, 2) # PW_RENDERFULLCONTENT

$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

if (-not $success) {
    $bmp.Dispose()
    Write-Error "PrintWindow failed."
    exit 1
}

$outDir = Split-Path -Parent $OutputPath
if ($outDir -and -not (Test-Path $outDir)) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output $OutputPath
`;
}

/** Path where the (regenerated-on-demand) capture script is written before execution. */
export function captureScriptPath(): string {
  return join(defaultScreenshotDir(), "capture-window.ps1");
}

export interface CaptureCommand {
  command: string;
  args: string[];
}

/** Build the argv for invoking the capture script via powershell.exe (no shell, so no quoting concerns). */
export function buildCaptureCommand(
  scriptPath: string,
  outputPath: string,
  processName: string = WORKBENCH_PROCESS_NAME
): CaptureCommand {
  return {
    command: "powershell.exe",
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
      "-ProcessName",
      processName,
      "-OutputPath",
      outputPath,
    ],
  };
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCommand(command: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`Capture command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr });
    });
  });
}

/** Validate that a file looks like a real PNG: exists, non-trivial size, correct magic bytes. */
export function validatePngFile(path: string, minBytes = 10 * 1024): { ok: boolean; reason?: string; size?: number } {
  if (!existsSync(path)) {
    return { ok: false, reason: "file does not exist" };
  }
  const stat = statSync(path);
  if (stat.size < minBytes) {
    return { ok: false, reason: `file too small (${stat.size} bytes, expected >= ${minBytes})`, size: stat.size };
  }
  return { ok: true, size: stat.size };
}

export function registerWbScreenshot(server: McpServer): void {
  server.registerTool(
    "wb_screenshot",
    {
      description:
        "Capture a screenshot of the running Arma Reforger Workbench window as a PNG, so the agent can " +
        "visually verify its own changes (entity placement, layout, terrain, etc.). Captures the *whole* " +
        "Workbench window (menus, panels, toolbars included) via an OS-level window capture (PrintWindow) — " +
        "not an isolated viewport render — because it works without any new Enforce Script handler or " +
        "Workbench restart. Requires Workbench to be running with a visible (non-minimized) window. Returns " +
        "an absolute PNG path; read it with the Read tool to view it. If the Workbench Diag build is showing " +
        "a modal assertion dialog, the capture will show that dialog instead of the viewport — that's real " +
        "state, not a capture bug.",
      inputSchema: {
        outputPath: z
          .string()
          .optional()
          .describe(
            "Optional absolute or relative path for the PNG. Defaults to a timestamped file under the OS " +
            "temp dir (enfusion-mcp-screenshots/). A .png extension is added if missing."
          ),
      },
    },
    async ({ outputPath }) => {
      try {
        const finalPath = resolveOutputPath(outputPath);
        mkdirSync(dirname(finalPath), { recursive: true });

        const scriptDir = defaultScreenshotDir();
        mkdirSync(scriptDir, { recursive: true });
        const scriptPath = captureScriptPath();
        writeFileSync(scriptPath, buildCaptureScript(), "utf-8");

        const { command, args } = buildCaptureCommand(scriptPath, finalPath, WORKBENCH_PROCESS_NAME);
        const { code, stdout, stderr } = await runCommand(command, args);

        if (code !== 0) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `**Screenshot Failed** — capture script exited with code ${code}.\n\n` +
                  `${stderr.trim() || stdout.trim() || "No output."}\n\n` +
                  `Is Workbench (${WORKBENCH_PROCESS_NAME}.exe) running with a visible window?`,
              },
            ],
            isError: true,
          };
        }

        const validation = validatePngFile(finalPath);
        if (!validation.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `**Screenshot Failed** — capture reported success but output is invalid: ${validation.reason}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text:
                `**Screenshot Captured** — ${finalPath} (${validation.size} bytes).\n\n` +
                `Use the Read tool on this path to view the image.`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error capturing screenshot: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
