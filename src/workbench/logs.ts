/**
 * Workbench log access: locate the newest logs_<timestamp> directory,
 * tail console.log incrementally, and parse script compile errors.
 *
 * File-based on purpose: reading logs from disk works even when the NET API
 * handlers failed to compile — which is exactly when you need the logs most
 * (observed live: a broken Game module blocks all EMCP_* handlers).
 */
import { readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

export interface CompileError {
  file: string;
  line: number;
  message: string;
}

/** SCRIPT (E): @"path/file.c,123": message */
const COMPILE_ERROR_RE = /SCRIPT\s+\(E\):\s+@"([^",]+\.c),(\d+)":\s+(.+)$/;

/** Strip a trailing \r left over from CRLF line endings (real Workbench logs are CRLF on Windows). */
function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

export function findLatestLogDir(baseDir: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(baseDir).filter(d => d.startsWith("logs_"));
  } catch {
    return null;
  }
  if (dirs.length === 0) return null;
  dirs.sort(); // timestamp format sorts lexicographically
  return join(baseDir, dirs[dirs.length - 1]!);
}

export function parseCompileErrors(text: string): CompileError[] {
  const errors: CompileError[] = [];
  for (const rawLine of text.split("\n")) {
    const line = stripCr(rawLine);
    const m = COMPILE_ERROR_RE.exec(line);
    if (m) errors.push({ file: m[1]!, line: parseInt(m[2]!, 10), message: m[3]!.trim() });
  }
  return errors;
}

export function readLogTail(
  logDir: string,
  opts: { lines?: number; filter?: RegExp; sinceByte?: number; fileName?: string } = {},
): { text: string; endByte: number } {
  const filePath = join(logDir, opts.fileName ?? "console.log");
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return { text: "", endByte: 0 };
  }
  const start = Math.max(opts.sinceByte ?? 0, 0);
  if (start >= size) return { text: "", endByte: size };

  // Read at most the last 1 MB when no cursor was given (protects against huge logs)
  const MAX_READ = 1024 * 1024;
  const from = opts.sinceByte !== undefined ? start : Math.max(start, size - MAX_READ);
  const fd = openSync(filePath, "r");
  const buf = Buffer.alloc(size - from);
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  let lines = buf.toString("utf-8").split("\n").map(stripCr);
  if (opts.filter) lines = lines.filter(l => opts.filter!.test(l));
  if (opts.lines !== undefined) lines = lines.filter(Boolean).slice(-opts.lines);
  return { text: lines.join("\n"), endByte: size };
}
