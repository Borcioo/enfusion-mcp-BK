import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";

/** Conditions under which a pitfall is considered relevant to the current context. */
export interface PitfallAppliesWhen {
  /** Case-insensitive substrings to match against free-form context text (description, method signatures, etc.). */
  keywords?: string[];
  /** script_create `scriptType` values this pitfall is relevant for. */
  scriptType?: string[];
  /** Engine/entity event names (e.g. "FRAME") referenced by the context. */
  events?: string[];
}

/** A single known Enfusion gotcha. */
export interface Pitfall {
  id: string;
  title: string;
  detail: string;
  appliesWhen: PitfallAppliesWhen;
}

/** Context describing what is currently being created/discussed, used to select relevant pitfalls. */
export interface PitfallContext {
  /** Free-form text — description, method signatures, class names, user prompt, etc. */
  text?: string;
  /** script_create scriptType, if applicable. */
  scriptType?: string;
  /** Engine event names referenced (e.g. from method signatures like "EOnFrame" -> "FRAME"). */
  events?: string[];
}

/** Load pitfalls from `<dataDir>/pitfalls.json`. Returns an empty array if the file is missing or invalid. */
export function loadPitfalls(dataDir: string): Pitfall[] {
  const path = join(dataDir, "pitfalls.json");
  if (!existsSync(path)) {
    logger.debug(`Pitfalls file not found: ${path}`);
    return [];
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      logger.warn(`Pitfalls file is not an array: ${path}`);
      return [];
    }
    return parsed as Pitfall[];
  } catch (e) {
    logger.warn(`Failed to load pitfalls from ${path}: ${e}`);
    return [];
  }
}

/**
 * Select pitfalls relevant to the given context. A pitfall matches when ANY of its
 * `appliesWhen` criteria are satisfied by the context (scriptType, keyword substring
 * in context.text, or event name overlap). Pitfalls with no matching criteria are
 * omitted — an empty context yields no matches.
 */
export function matchPitfalls(pitfalls: Pitfall[], context: PitfallContext): Pitfall[] {
  const lowerText = context.text?.toLowerCase();
  const lowerEvents = context.events?.map((e) => e.toLowerCase());

  return pitfalls.filter((p) => {
    const { keywords, scriptType, events } = p.appliesWhen;

    if (scriptType && context.scriptType && scriptType.includes(context.scriptType)) {
      return true;
    }

    if (keywords && lowerText) {
      if (keywords.some((k) => lowerText.includes(k.toLowerCase()))) {
        return true;
      }
    }

    if (events && lowerEvents) {
      const eventSet = new Set(events.map((e) => e.toLowerCase()));
      if (lowerEvents.some((e) => eventSet.has(e))) {
        return true;
      }
    }

    return false;
  });
}

/** Format matched pitfalls as a human-readable Markdown list for injection into tool output. */
export function formatPitfalls(pitfalls: Pitfall[]): string {
  if (pitfalls.length === 0) return "";
  const lines = pitfalls.map((p) => `- **${p.title}**: ${p.detail}`);
  return lines.join("\n");
}
