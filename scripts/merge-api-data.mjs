/**
 * Merge two API index snapshots into a best-of-both union.
 *
 * Motivation: the local scrape (--source local) yields a WIDE class set but
 * sparse briefs and an empty hierarchy; the remote scrape (--source remote,
 * arexplorer.zeroy.com, Doxygen 1.17.0) yields RICH briefs + a populated
 * hierarchy but a narrower, public-API-only class set (e.g. fewer arma classes,
 * shallower root inheritance). Neither is a superset of the other. This merges
 * them so we keep the wide coverage AND gain the rich descriptions.
 *
 * Merge rules (per class, keyed by name):
 *   - Union of both sets. A class present in only one side is taken verbatim.
 *   - For a class in BOTH: the OLD entry is the base (preserves parents[],
 *     methods[], properties[] that the search engine + tests rely on, incl. the
 *     deeper root inheritance like IEntity->Managed), and we OVERLAY the remote
 *     brief/description when richer, plus remote enums when the old entry has
 *     none. We never drop old structural data.
 *   - hierarchy.json: old was empty; take the remote hierarchy to fill the gap
 *     (supplementary — per-class parents[] still drive getInheritanceChain).
 *
 * Usage: node scripts/merge-api-data.mjs <oldDir> <remoteDir> <outDir>
 *   oldDir/remoteDir/outDir each contain enfusion-classes.json, arma-classes.json,
 *   groups.json, hierarchy.json.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveBrief, isBoilerplateBrief } from "../dist/scraper/doxygen-parser.js";

/** Best real (non-boilerplate) brief for a class from its own + remote data. */
function bestBrief(name, oldCls, remote) {
  if (oldCls && oldCls.brief && !isBoilerplateBrief(oldCls.brief)) return oldCls.brief;
  if (remote) {
    const d = deriveBrief(remote.brief || "", remote.description || "", name);
    if (d) return d;
  }
  if (oldCls) {
    const d = deriveBrief(oldCls.brief || "", oldCls.description || "", name);
    if (d) return d;
  }
  return "";
}

const [oldDir, remoteDir, outDir] = process.argv.slice(2);
if (!oldDir || !remoteDir || !outDir) {
  console.error("Usage: node scripts/merge-api-data.mjs <oldDir> <remoteDir> <outDir>");
  process.exit(1);
}

const load = (dir, file) => JSON.parse(readFileSync(join(dir, file), "utf8"));
const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;

/** Merge one classes file (enfusion or arma). Returns the merged array + stats. */
function mergeClasses(fileName) {
  const oldArr = load(oldDir, fileName);
  const remoteArr = load(remoteDir, fileName);

  const remoteByName = new Map(remoteArr.map((c) => [c.name, c]));
  const merged = [];
  let enriched = 0;
  let addedFromRemote = 0;

  const seen = new Set();
  // 1. Walk the OLD set (the base — preserves wide coverage + structural data).
  for (const oldCls of oldArr) {
    seen.add(oldCls.name);
    const remote = remoteByName.get(oldCls.name);
    if (!remote) {
      merged.push(oldCls);
      continue;
    }
    // Overlay a clean brief + richer description without touching old structure.
    const out = { ...oldCls };
    const brief = bestBrief(oldCls.name, oldCls, remote);
    if (brief && brief !== oldCls.brief) enriched++;
    out.brief = brief;
    if (nonEmpty(remote.description) && remote.description.length > (oldCls.description?.length ?? 0)) {
      out.description = remote.description;
    }
    if (Array.isArray(remote.enums) && remote.enums.length && !(Array.isArray(oldCls.enums) && oldCls.enums.length)) {
      out.enums = remote.enums;
    }
    merged.push(out);
  }
  // 2. Add classes that exist ONLY in the remote set (e.g. enfusion grew).
  for (const remote of remoteArr) {
    if (seen.has(remote.name)) continue;
    merged.push({ ...remote, brief: bestBrief(remote.name, null, remote) });
    addedFromRemote++;
  }

  const withBrief = merged.filter((c) => nonEmpty(c.brief)).length;
  return {
    merged,
    stats: {
      file: fileName,
      total: merged.length,
      old: oldArr.length,
      remote: remoteArr.length,
      addedFromRemote,
      enriched,
      briefPct: Math.round((100 * withBrief) / merged.length),
    },
  };
}

for (const file of ["enfusion-classes.json", "arma-classes.json"]) {
  const { merged, stats } = mergeClasses(file);
  writeFileSync(join(outDir, file), JSON.stringify(merged));
  console.log(JSON.stringify(stats));
}

// groups: union by name (old base, add remote-only).
{
  const oldG = load(oldDir, "groups.json");
  const remoteG = load(remoteDir, "groups.json");
  const seen = new Set(oldG.map((g) => g.name));
  const merged = [...oldG, ...remoteG.filter((g) => !seen.has(g.name))];
  writeFileSync(join(outDir, "groups.json"), JSON.stringify(merged));
  console.log(JSON.stringify({ file: "groups.json", total: merged.length, old: oldG.length, remote: remoteG.length }));
}

// hierarchy: old was empty; take remote to fill the gap (supplementary).
{
  const oldH = load(oldDir, "hierarchy.json");
  const remoteH = load(remoteDir, "hierarchy.json");
  const chosen = (Array.isArray(remoteH) && remoteH.length >= (Array.isArray(oldH) ? oldH.length : 0)) ? remoteH : oldH;
  writeFileSync(join(outDir, "hierarchy.json"), JSON.stringify(chosen));
  console.log(JSON.stringify({ file: "hierarchy.json", chosen: chosen.length, old: (oldH?.length ?? 0), remote: (remoteH?.length ?? 0) }));
}
