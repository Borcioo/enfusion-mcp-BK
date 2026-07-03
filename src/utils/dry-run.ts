/**
 * Shared preview formatting for mutating tools' `dryRun` mode.
 *
 * When a tool is invoked with `dryRun: true` it must not touch disk
 * (no `writeFileSync`/`mkdirSync`). Instead it computes the same
 * paths/content it would have written and hands them to this helper
 * to build a human-readable preview.
 */

export interface DryRunFile {
  /** Absolute or relative path that would have been created/written. */
  path: string;
  /** File content, when available. Omit for directories or files whose
   *  content isn't meaningful to preview (e.g. a placeholder note). */
  content?: string;
}

/**
 * Format a dry-run preview response.
 *
 * Always prefixes the response with `**[dry-run]**`, lists every planned
 * path, then appends a fenced content block for each file that has content.
 */
export function formatDryRun(
  files: DryRunFile[],
  title = "No files were written."
): string {
  const lines: string[] = [`**[dry-run]** ${title}`, ""];

  lines.push(`### Planned paths (${files.length})`);
  for (const f of files) {
    lines.push(`- ${f.path}`);
  }

  for (const f of files) {
    if (f.content === undefined) continue;
    lines.push("");
    lines.push(`### ${f.path}`);
    lines.push("```");
    lines.push(f.content);
    lines.push("```");
  }

  return lines.join("\n");
}
