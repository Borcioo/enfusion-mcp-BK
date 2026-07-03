import type { SearchEngine } from "../index/search-engine.js";
import { checkScript } from "../tools/script-check.js";

/**
 * Lightweight, high-precision static cross-reference check for Enforce Script
 * (`.c`) content written via the `project` / `project_patch` tools.
 *
 * This is regex-based heuristic analysis, NOT a parser. It intentionally
 * favors false negatives over false positives: a missed hallucination is
 * cheap (the modder finds out at compile time anyway), but a bogus "this API
 * doesn't exist" warning on real code erodes trust in every future warning.
 *
 * Precision strategy:
 *  - Only inspects `ClassName.Method(` call sites where `ClassName` looks
 *    like a type reference (starts uppercase). Lowercase-first identifiers
 *    (locals, member vars) are never treated as class references.
 *  - Only flags a call when `ClassName` IS a class present in the offline
 *    API index (`hasClass`). Anything not in the index — including every
 *    class/enum the mod itself declares — is silently skipped, never
 *    reported as "unknown class". This is deliberate: this checker's job is
 *    to catch hallucinated *members* on *known* classes, not to police
 *    unknown classes (that would blow up on any class outside the base API,
 *    including legitimate ones from other mods).
 *  - Classes (re-)declared in the same file — including `modded class` on a
 *    real indexed class, which is how mods legitimately add new methods to
 *    existing engine classes — are excluded outright, even though they may
 *    also resolve via `hasClass`.
 *  - A short allow-list of Script built-ins/idioms (Print, Math, string,
 *    super, Cast, ToString, Format, ...) is never flagged.
 *  - Output is capped and deduplicated so one bad pattern doesn't spam.
 */

const MAX_WARNINGS = 5;

/** Global functions/keywords that must never be treated as a class reference. */
const SKIP_IDENTIFIERS = new Set([
  "print",
  "printformat",
  "math",
  "string",
  "super",
  "this",
  "getgame",
  "class",
  "vector",
  "array",
  "set",
  "map",
  "ref",
  "typename",
  "format",
]);

/** Method names that are generic script idioms valid on essentially any class. */
const SKIP_METHODS = new Set(["cast", "tostring", "format"]);

const CLASS_DECL_RE = /\b(?:modded\s+)?class\s+(\w+)/g;
const ENUM_DECL_RE = /\benum\s+(\w+)/g;
const METHOD_CALL_RE = /\b([A-Z]\w*)\.([A-Za-z_]\w*)\s*\(/g;

/**
 * Collect class/enum names declared in `content` (case-insensitive), so
 * calls to them are never flagged as unknown-member on a "known" class.
 */
export function extractLocalDeclarations(content: string): Set<string> {
  const names = new Set<string>();
  let m: RegExpExecArray | null;

  CLASS_DECL_RE.lastIndex = 0;
  while ((m = CLASS_DECL_RE.exec(content))) names.add(m[1].toLowerCase());

  ENUM_DECL_RE.lastIndex = 0;
  while ((m = ENUM_DECL_RE.exec(content))) names.add(m[1].toLowerCase());

  return names;
}

/**
 * Scan `content` for `ClassName.Method(` call sites and validate each
 * against the offline API index. Returns human-readable warning strings
 * (capped at MAX_WARNINGS); an empty array means no issues were found — it
 * does NOT mean the script is guaranteed correct (this is heuristic, not a
 * compiler).
 *
 * `extraLocalNames` lets callers fold in class/enum names declared in
 * sibling files of the same mod, so cross-file mod-local classes aren't
 * flagged either.
 */
export function validateScriptReferences(
  searchEngine: SearchEngine,
  content: string,
  extraLocalNames: Iterable<string> = []
): string[] {
  const warnings: string[] = [];
  const localNames = extractLocalDeclarations(content);
  for (const n of extraLocalNames) localNames.add(n.toLowerCase());

  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  METHOD_CALL_RE.lastIndex = 0;

  while ((m = METHOD_CALL_RE.exec(content)) && warnings.length < MAX_WARNINGS) {
    const [, className, methodName] = m;
    const classKey = className.toLowerCase();
    const methodKey = methodName.toLowerCase();

    if (SKIP_IDENTIFIERS.has(classKey)) continue;
    if (SKIP_METHODS.has(methodKey)) continue;
    if (localNames.has(classKey)) continue;

    // Not in the base API index at all — could be a class from another mod,
    // DayZ-layer content, or something the local index just doesn't cover.
    // Don't flag: false positives here are worse than a missed check.
    if (!searchEngine.hasClass(className)) continue;

    const dedupeKey = `${classKey}.${methodKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const result = checkScript(searchEngine, className, methodName);
    if (!result.found) {
      warnings.push(`${className}.${methodName}(): ${result.message}`);
    }
  }

  return warnings;
}

/** Format warnings for appending to a tool response's success text. */
export function formatValidationWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  const lines = ["", `Cross-reference warnings (${warnings.length}) — write still succeeded, but review before compiling:`];
  for (const w of warnings) lines.push(`- ${w}`);
  return lines.join("\n");
}
