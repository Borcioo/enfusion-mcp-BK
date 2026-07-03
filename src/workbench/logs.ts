/**
 * Workbench log access: locate the newest logs_<timestamp> directory,
 * tail console.log incrementally, and parse script compile errors.
 *
 * File-based on purpose: reading logs from disk works even when the NET API
 * handlers failed to compile — which is exactly when you need the logs most
 * (observed live: a broken Game module blocks all EMCP_* handlers).
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

export interface CompileError {
  file: string;
  line: number;
  message: string;
}

/** SCRIPT (E): @"path/file.c,123": message */
const COMPILE_ERROR_RE = /SCRIPT\s+\(E\):\s+@"([^",]+\.c),(\d+)":\s+(.+)$/;

/**
 * Strip trailing \r characters left over from CRLF line endings (real Workbench
 * logs are CRLF on Windows). Strips all trailing CRs, not just one, since logs
 * that have passed through Windows tooling (or a mis-normalized checkout) can
 * end up with doubled "\r\r\n" sequences.
 */
function stripCr(line: string): string {
  return line.replace(/\r+$/, "");
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

/**
 * Parse compile errors that appeared in the log strictly after `beforeByte`
 * (a cursor captured before some triggering action, e.g. a reload). Reads
 * only the new bytes rather than the whole file.
 */
export function collectNewCompileErrors(
  logDir: string,
  beforeByte: number,
  fileName = "console.log",
): CompileError[] {
  const { text } = readLogTail(logDir, { sinceByte: beforeByte, fileName });
  return parseCompileErrors(text);
}

/** Candidate parent directories that hold logs_<timestamp> subfolders. */
export function candidateLogBases(config: Config): string[] {
  const candidates: string[] = [];
  if (config.workbenchProfileDir) candidates.push(config.workbenchProfileDir);
  candidates.push(
    join(homedir(), "Documents", "My Games", "ArmaReforgerWorkbench", "logs"),
    join(homedir(), "OneDrive", "Dokumenty", "My Games", "ArmaReforgerWorkbench", "logs"),
    join(homedir(), "OneDrive", "Documents", "My Games", "ArmaReforgerWorkbench", "logs")
  );
  return candidates;
}

/** Resolve the first existing candidate logs base directory. */
export function resolveLogsBase(config: Config): string | null {
  for (const candidate of candidateLogBases(config)) {
    if (existsSync(candidate)) {
      logger.debug(`workbench logs: using logs base dir ${candidate}`);
      return candidate;
    }
  }
  return null;
}

/** Locate a script source file on disk to pull context lines around a compile error. */
export function findSourceFile(config: Config, relFile: string): string | null {
  const roots: string[] = [];
  if (config.defaultMod) roots.push(join(config.projectPath, config.defaultMod));
  roots.push(config.projectPath);

  for (const root of roots) {
    const candidate = join(root, relFile);
    if (existsSync(candidate)) return candidate;
  }

  // Fall back to scanning immediate subdirectories of projectPath (addon folders)
  try {
    for (const entry of readdirSync(config.projectPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(config.projectPath, entry.name, relFile);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // projectPath may not exist / be readable — ignore
  }

  return null;
}

/** Read up to `radius` lines of context before/after the 1-indexed error line. */
export function readContext(filePath: string, line: number, radius = 5): string | null {
  try {
    const lines = readFileSync(filePath, "utf-8").split("\n");
    const start = Math.max(0, line - 1 - radius);
    const end = Math.min(lines.length, line + radius);
    return lines
      .slice(start, end)
      .map((l, i) => {
        const lineNo = start + i + 1;
        const marker = lineNo === line ? ">>" : "  ";
        return `${marker} ${lineNo}: ${l}`;
      })
      .join("\n");
  } catch {
    return null;
  }
}

/** Format a list of compile errors as Markdown, with ±5-line source context when available. */
export function formatCompileErrors(config: Config, logLabel: string, errors: CompileError[]): string {
  const parts: string[] = [`**Compile Errors** (${logLabel})\n`];
  for (const err of errors) {
    parts.push(`- ${err.file}:${err.line}: ${err.message}`);
    const sourcePath = findSourceFile(config, err.file);
    if (sourcePath) {
      const context = readContext(sourcePath, err.line);
      if (context) parts.push("```\n" + context + "\n```");
    } else {
      parts.push(`  (source file not found for context: ${err.file})`);
    }
  }
  return parts.join("\n");
}
