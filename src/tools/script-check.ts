import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchEngine, MethodSearchResult } from "../index/search-engine.js";
import { levenshtein, trigramSimilarity } from "../utils/fuzzy.js";

export interface MethodSuggestion {
  name: string;
  signature: string;
  declaringClass: string;
}

export interface ScriptCheckResult {
  /** True when the exact (own or inherited) method was found on the class. */
  found: boolean;
  /** Whether the queried class itself exists in the index. */
  classExists: boolean;
  /** Name of the class that actually declares the method (may differ from the queried class). */
  declaringClass?: string;
  /** Canonical method signature, when found. */
  signature?: string;
  /** True when the method was found via inheritance rather than declared directly on the queried class. */
  inherited?: boolean;
  /** Ranked "did you mean" method suggestions when the method wasn't found (but the class exists). */
  suggestions: MethodSuggestion[];
  /** Ranked "did you mean" class-name suggestions when the class itself wasn't found. */
  classSuggestions?: string[];
  /** Human-readable summary message. */
  message: string;
}

/**
 * Extract a bare method name from caller input that may be a full signature,
 * e.g. "IEntity GetOwner()" -> "GetOwner", "GetOwner" -> "GetOwner".
 */
export function extractMethodName(input: string): string {
  const trimmed = input.trim();

  // Strip trailing "(...)" and anything after it.
  const parenIdx = trimmed.indexOf("(");
  const beforeParen = parenIdx >= 0 ? trimmed.slice(0, parenIdx) : trimmed;

  // Take the last whitespace-separated token (drops return type / modifiers).
  const tokens = beforeParen.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return trimmed;
  return tokens[tokens.length - 1];
}

const FUZZY_LEVENSHTEIN_MAX = 3;
const FUZZY_TRIGRAM_MIN = 0.3;
const MAX_SUGGESTIONS = 5;

/**
 * Rank a set of candidate names against a query using Levenshtein distance
 * (with a trigram-similarity fallback for longer names), reusing the shared
 * fuzzy-matching infra from src/utils/fuzzy.ts.
 */
function rankByFuzzy<T>(
  query: string,
  candidates: T[],
  nameOf: (c: T) => string,
  limit = MAX_SUGGESTIONS
): T[] {
  const q = query.toLowerCase();
  const scored: Array<{ item: T; score: number }> = [];

  for (const item of candidates) {
    const name = nameOf(item).toLowerCase();
    const dist = levenshtein(q, name);
    let score: number;
    if (dist <= FUZZY_LEVENSHTEIN_MAX) {
      score = 100 - dist * 10;
    } else {
      const sim = trigramSimilarity(q, name);
      if (sim < FUZZY_TRIGRAM_MIN) continue;
      score = sim * 50;
    }
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.item);
}

/**
 * Validate that `method` exists (own or inherited) on `className`, using the
 * offline API index. Inheritance-aware: reuses SearchEngine.getInheritedMembers()
 * to walk the parent chain rather than re-implementing it here.
 */
export function checkScript(
  searchEngine: SearchEngine,
  className: string,
  method: string
): ScriptCheckResult {
  const methodName = extractMethodName(method);

  if (!searchEngine.hasClass(className)) {
    const classSuggestions = searchEngine
      .searchClasses(className, "all", MAX_SUGGESTIONS)
      .map((c) => c.name);
    return {
      found: false,
      classExists: false,
      suggestions: [],
      classSuggestions,
      message:
        classSuggestions.length > 0
          ? `Class "${className}" not found in the API index. Did you mean: ${classSuggestions.join(", ")}?`
          : `Class "${className}" not found in the API index.`,
    };
  }

  const cls = searchEngine.getClass(className)!;

  const ownMethods = [
    ...(cls.methods || []),
    ...(cls.protectedMethods || []),
    ...(cls.staticMethods || []),
  ];
  const ownMatch = ownMethods.find((m) => m.name.toLowerCase() === methodName.toLowerCase());
  if (ownMatch) {
    return {
      found: true,
      classExists: true,
      declaringClass: cls.name,
      signature: ownMatch.signature,
      inherited: false,
      suggestions: [],
      message: `${cls.name}.${ownMatch.name} confirmed: ${ownMatch.signature}`,
    };
  }

  const inherited = searchEngine.getInheritedMembers(className);
  const inheritedMatch = inherited.methods.find(
    (m) => m.method.name.toLowerCase() === methodName.toLowerCase()
  );
  if (inheritedMatch) {
    return {
      found: true,
      classExists: true,
      declaringClass: inheritedMatch.className,
      signature: inheritedMatch.method.signature,
      inherited: true,
      suggestions: [],
      message: `${methodName} confirmed on ${className} (inherited from ${inheritedMatch.className}): ${inheritedMatch.method.signature}`,
    };
  }

  // Not found — build the full candidate pool (own + inherited) and fuzzy-match.
  const allCandidates: MethodSuggestion[] = [
    ...ownMethods.map((m) => ({ name: m.name, signature: m.signature, declaringClass: cls.name })),
    ...inherited.methods.map((r: MethodSearchResult) => ({
      name: r.method.name,
      signature: r.method.signature,
      declaringClass: r.className,
    })),
  ];

  const suggestions = rankByFuzzy(methodName, allCandidates, (c) => c.name);

  const suggestionText =
    suggestions.length > 0
      ? ` Did you mean: ${suggestions.map((s) => `${s.name} (on ${s.declaringClass})`).join(", ")}?`
      : "";

  return {
    found: false,
    classExists: true,
    suggestions,
    message: `Method "${methodName}" not found on ${className} (checked own and inherited members).${suggestionText}`,
  };
}

function formatCheckResult(result: ScriptCheckResult): string {
  if (result.found) {
    const lines = [`✅ ${result.message}`];
    if (result.inherited) {
      lines.push(`Note: this method is declared on ${result.declaringClass}, not the queried class.`);
    }
    return lines.join("\n");
  }

  const lines = [`❌ ${result.message}`];
  if (!result.classExists) {
    return lines.join("\n");
  }

  if (result.suggestions.length > 0) {
    lines.push("");
    lines.push("Suggestions:");
    for (const s of result.suggestions) {
      lines.push(`- ${s.name} on ${s.declaringClass}: ${s.signature}`);
    }
  }
  return lines.join("\n");
}

export function registerScriptCheck(server: McpServer, searchEngine: SearchEngine): void {
  server.registerTool(
    "script_check",
    {
      description:
        "Validate that a class + method combination is real before writing script that calls it. Inheritance-aware: checks the class's own methods first, then walks the parent chain via SearchEngine so methods declared on a parent class (e.g. GetPlayerManager on ChimeraGame, not SCR_BaseGameMode) are still confirmed and correctly attributed. On a typo or wrong method, returns fuzzy 'did you mean' suggestions across own + inherited methods; on an unknown class, returns fuzzy class-name suggestions. Accepts either a bare method name or a fuller pasted signature.",
      inputSchema: {
        className: z.string().describe("The class name to check the method against"),
        method: z
          .string()
          .describe(
            "Bare method name (e.g. 'GetHealth'), or a fuller pasted signature (e.g. 'float GetHealth()') — the bare name will be extracted"
          ),
      },
    },
    async ({ className, method }) => {
      const result = checkScript(searchEngine, className, method);
      return { content: [{ type: "text", text: formatCheckResult(result) }] };
    }
  );
}
