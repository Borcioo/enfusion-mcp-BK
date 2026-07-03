/**
 * Component compatibility matrix: which ScriptComponent classes co-occur
 * on which root entity types across base-game .et prefabs.
 *
 * Pure/fs-free: takes already-loaded .et text, extracts (entity type,
 * component class names) via the Enfusion text parser, and folds them into
 * a co-occurrence count. Scanning the filesystem/.pak archives and caching
 * the result live in src/tools/component-search.ts + src/utils/component-matrix-cache.ts.
 *
 * SCOPE NOTE: counts are of LOCALLY-DECLARED components only — .et prefab
 * inheritance (`EntityClass : "{GUID}Parent.et" { ... }`) is NOT resolved.
 * See the docstring on `extractEntityComponents` below for the rationale.
 * Treat matrix results as "components commonly declared directly on this
 * entity type", not as an exhaustive/fully-resolved component set.
 */
import { parse } from "../formats/enfusion-text.js";

/** Extracted facts from a single .et prefab: its root entity type and attached component classes. */
export interface EntityComponents {
  entityType: string;
  components: string[];
}

/** Per-entity-type aggregate: component class name -> number of .et files it appeared in. */
export interface ComponentMatrixEntry {
  entityType: string;
  /** How many .et files contributed to this entity type's stats. */
  fileCount: number;
  /** component class name -> co-occurrence count. */
  components: Record<string, number>;
}

/** entityType -> aggregate stats. */
export type ComponentMatrix = Record<string, ComponentMatrixEntry>;

/** A component ranked by how often it appears on a given entity type. */
export interface RankedComponent {
  component: string;
  count: number;
  /** count / fileCount for this entity type, in [0, 1]. */
  frequency: number;
}

/**
 * Parse a single .et file's text and extract its root entity type and the
 * component classes listed in its top-level `components { ... }` block.
 * Returns null if the text does not parse as a valid Enfusion node (e.g.
 * corrupt/binary/unexpected content) — callers should skip such files.
 *
 * IMPORTANT — LOCAL COMPONENTS ONLY, INHERITANCE IS NOT RESOLVED:
 * .et prefabs commonly inherit from a parent prefab via
 * `EntityClass : "{GUID}Path/To/Parent.et" { components { ... } }` and, in
 * that case, typically declare only the components they *add or override* —
 * the rest are inherited silently from the parent chain (see
 * src/utils/prefab-ancestry.ts, which exists precisely to resolve that
 * chain for a single prefab on demand). This function does NOT walk that
 * chain: it only reports components declared directly in this file's own
 * `components { ... }` block. Entity types built mostly through deep
 * inheritance (declaring few local overrides) will therefore be
 * undercounted relative to their true, fully-resolved component set.
 *
 * This is an intentional, documented trade-off, not an oversight:
 * 1. Resolving ancestry for every .et in the matrix would require
 *    GUID -> path resolution across the full ~84k-file base-game asset
 *    set for every prefab scanned, which is disproportionately expensive
 *    for a "typically attached components" heuristic.
 * 2. Locally-declared co-occurrence is still a useful signal on its own:
 *    it answers "what do authors commonly add directly to this entity
 *    type" rather than "what is the exhaustive, fully-resolved component
 *    set for this entity type." Callers (and the LLM consuming tool
 *    output) should treat matrix results as "commonly declared on X",
 *    not as an exhaustive/authoritative component list for X.
 */
export function extractEntityComponents(etText: string): EntityComponents | null {
  let node;
  try {
    node = parse(etText);
  } catch {
    return null;
  }
  if (!node || !node.type) return null;

  const componentsNode = node.children.find((c) => c.type === "components");
  const components = componentsNode ? componentsNode.children.map((c) => c.type) : [];

  return { entityType: node.type, components };
}

/**
 * Build a component co-occurrence matrix from a collection of .et file
 * contents. Files that fail to parse are silently skipped (graceful
 * degradation — a handful of malformed prefabs must not abort the scan).
 */
export function buildComponentMatrix(etTexts: Iterable<string>): ComponentMatrix {
  const matrix: ComponentMatrix = {};

  for (const text of etTexts) {
    const extracted = extractEntityComponents(text);
    if (!extracted) continue;

    let entry = matrix[extracted.entityType];
    if (!entry) {
      entry = { entityType: extracted.entityType, fileCount: 0, components: {} };
      matrix[extracted.entityType] = entry;
    }
    entry.fileCount++;

    // Count each distinct component class once per file, even if (unusually)
    // it appears more than once in the same components block.
    const seenInThisFile = new Set<string>();
    for (const comp of extracted.components) {
      if (seenInThisFile.has(comp)) continue;
      seenInThisFile.add(comp);
      entry.components[comp] = (entry.components[comp] ?? 0) + 1;
    }
  }

  return matrix;
}

/**
 * Get the components typically attached to a given entity type, ranked by
 * co-occurrence count (descending). Returns an empty array for an unknown
 * entity type.
 */
export function getTypicalComponents(
  matrix: ComponentMatrix,
  entityType: string,
  limit = 25
): RankedComponent[] {
  const entry = matrix[entityType];
  if (!entry || entry.fileCount === 0) return [];

  const ranked: RankedComponent[] = Object.entries(entry.components).map(([component, count]) => ({
    component,
    count,
    frequency: count / entry.fileCount,
  }));

  ranked.sort((a, b) => b.count - a.count || a.component.localeCompare(b.component));
  return ranked.slice(0, limit);
}

/** List all entity types known to the matrix, sorted by file count (descending). */
export function listEntityTypes(matrix: ComponentMatrix): Array<{ entityType: string; fileCount: number }> {
  return Object.values(matrix)
    .map((e) => ({ entityType: e.entityType, fileCount: e.fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount || a.entityType.localeCompare(b.entityType));
}
