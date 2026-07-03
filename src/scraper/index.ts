import { readHtmlFromZip, readFileFromZip } from "./source-local.js";
import {
  fetchAnnotatedPage,
  fetchHierarchyPage,
  fetchClassPages,
} from "./source-remote.js";
import {
  parseAnnotatedPage,
  parseClassPage,
  parseHierarchyPage,
  parseGroupPage,
  parseTutorialPage,
} from "./doxygen-parser.js";
import { writeOutput, type ScrapeOutput } from "./writer.js";
import { logger } from "../utils/logger.js";
import type { ClassInfo, GroupInfo, HierarchyNode, WikiPage } from "../index/types.js";

export interface ScrapeOptions {
  source: "local" | "remote";
  workbenchPath: string;
  dataDir: string;
}

function scrapeLocalSource(
  workbenchPath: string,
  source: "enfusion" | "arma"
): {
  classes: ClassInfo[];
  groups: GroupInfo[];
  hierarchy: HierarchyNode[];
  wikiPages: WikiPage[];
} {
  const classes: ClassInfo[] = [];
  const groups: GroupInfo[] = [];
  let hierarchy: HierarchyNode[] = [];
  const wikiPages: WikiPage[] = [];

  // 1. Parse annotated.html for the class list
  const annotatedHtml = readFileFromZip(workbenchPath, source, "annotated.html");
  if (!annotatedHtml) {
    logger.error(`Could not read annotated.html from ${source} zip`);
    return { classes, groups, hierarchy, wikiPages };
  }

  const classList = parseAnnotatedPage(annotatedHtml);
  logger.info(`Found ${classList.length} classes in ${source} annotated.html`);

  // 2. Parse hierarchy.html
  const hierarchyHtml = readFileFromZip(workbenchPath, source, "hierarchy.html");
  if (hierarchyHtml) {
    hierarchy = parseHierarchyPage(hierarchyHtml);
    logger.info(`Parsed ${hierarchy.length} hierarchy nodes from ${source}`);
  }

  // 3. Parse each class page
  let processed = 0;
  for (const entry of readHtmlFromZip(
    workbenchPath,
    source,
    /^interface[A-Z].*\.html$/
  )) {
    // Skip -members.html files
    if (entry.filename.includes("-members")) continue;

    try {
      const classInfo = parseClassPage(entry.html, source, entry.filename);
      if (classInfo.name) {
        classes.push(classInfo);
      }
    } catch (e) {
      logger.warn(`Failed to parse ${entry.filename}: ${e}`);
    }

    processed++;
    if (processed % 200 === 0) {
      logger.info(`  Parsed ${processed} class pages from ${source}...`);
    }
  }
  logger.info(`Parsed ${classes.length} classes from ${source}`);

  // 4. Parse group pages
  for (const entry of readHtmlFromZip(
    workbenchPath,
    source,
    /^group__.*\.html$/
  )) {
    try {
      const group = parseGroupPage(entry.html);
      if (group.name) {
        groups.push(group);
      }
    } catch (e) {
      logger.warn(`Failed to parse group ${entry.filename}: ${e}`);
    }
  }
  logger.info(`Parsed ${groups.length} groups from ${source}`);

  // 5. Parse tutorial pages (Page_*.html)
  for (const entry of readHtmlFromZip(
    workbenchPath,
    source,
    /^Page_.*\.html$/
  )) {
    try {
      const page = parseTutorialPage(entry.html, source, entry.filename);
      if (page.title) {
        wikiPages.push(page);
      }
    } catch (e) {
      logger.warn(`Failed to parse tutorial ${entry.filename}: ${e}`);
    }
  }
  logger.info(`Parsed ${wikiPages.length} tutorial pages from ${source}`);

  // 6-7. Cross-reference hierarchy with class data and fix circular refs.
  crossReferenceHierarchy(classes, hierarchy);

  return { classes, groups, hierarchy, wikiPages };
}

/**
 * Cross-reference hierarchy.html data with class data (mutates `classes` in place).
 *
 * The hierarchy parsed from hierarchy.html is the authoritative source for
 * inheritance relationships. The <map><area> diagram parser in parseClassPage
 * is a heuristic that frequently reverses parent/child direction (especially
 * for root classes with no ancestors), so we override its results with
 * hierarchy data whenever available. Then detect and fix circular parent
 * references left over from the heuristic.
 */
function crossReferenceHierarchy(
  classes: ClassInfo[],
  hierarchy: HierarchyNode[]
): void {
  const hChildMap = new Map<string, string[]>();  // parent → children
  const hParentMap = new Map<string, string[]>(); // child → parents

  for (const node of hierarchy) {
    for (const child of node.children) {
      // parent → child
      let children = hChildMap.get(node.name);
      if (!children) {
        children = [];
        hChildMap.set(node.name, children);
      }
      children.push(child);

      // child → parent (inverted)
      let parents = hParentMap.get(child);
      if (!parents) {
        parents = [];
        hParentMap.set(child, parents);
      }
      if (!parents.includes(node.name)) {
        parents.push(node.name);
      }
    }
  }

  const classesInHierarchy = new Set([...hChildMap.keys(), ...hParentMap.keys()]);

  for (const cls of classes) {
    if (classesInHierarchy.has(cls.name)) {
      // Hierarchy data is authoritative — override map-derived relationships
      cls.parents = hParentMap.get(cls.name) ?? [];
      cls.children = hChildMap.get(cls.name) ?? [];
    }
    // Classes not in the hierarchy keep their map-derived data (best-effort).
  }

  // Validate: detect and fix circular parent references.
  // If A.parents includes B AND B.parents includes A, one direction is wrong.
  // Remove the less-likely direction.
  const classMap = new Map(classes.map((c) => [c.name, c]));
  for (const cls of classes) {
    cls.parents = cls.parents.filter((parentName) => {
      const parentCls = classMap.get(parentName);
      if (!parentCls) return true; // keep refs to unknown classes
      if (parentCls.parents.includes(cls.name)) {
        // Circular reference detected. Use heuristic: SCR_X extends X, not vice versa.
        // Also: a class with MORE descendants is more likely the parent.
        const clsIsScr = cls.name.startsWith("SCR_") && !parentName.startsWith("SCR_");
        if (clsIsScr) return true; // SCR_X extends X — this direction is correct
        const parentIsScr = parentName.startsWith("SCR_") && !cls.name.startsWith("SCR_");
        if (parentIsScr) return false; // X says parent is SCR_X — wrong
        // For non-SCR pairs, keep the one where parent has more children
        return (parentCls.children.length >= cls.children.length);
      }
      return true;
    });
  }

  logger.info(
    `Hierarchy cross-reference: ${classesInHierarchy.size} classes updated from hierarchy data`
  );
}

/**
 * Scrape the remote Doxygen mirror at https://arexplorer.zeroy.com/.
 *
 * Unlike the local zips (which are split into separate
 * EnfusionScriptAPIPublic / ArmaReforgerScriptAPIPublic archives), the
 * remote mirror is a single unified site covering both the Enfusion engine
 * and Arma Reforger game-script classes. There is no structural signal to
 * split them, so we use the modding convention that `SCR_`-prefixed classes
 * are Arma Reforger game code and everything else is engine (Enfusion) code.
 * This is a best-effort heuristic, documented here and in the scrape report.
 */
async function scrapeRemoteSource(): Promise<{
  classes: ClassInfo[];
  groups: GroupInfo[];
  hierarchy: HierarchyNode[];
  wikiPages: WikiPage[];
}> {
  const classifySource = (name: string): "enfusion" | "arma" =>
    name.startsWith("SCR_") ? "arma" : "enfusion";

  // 1. Class list
  const annotatedHtml = await fetchAnnotatedPage();
  const classList = parseAnnotatedPage(annotatedHtml);
  logger.info(`Found ${classList.length} classes on remote mirror`);

  // 2. Hierarchy
  let hierarchy: HierarchyNode[] = [];
  try {
    const hierarchyHtml = await fetchHierarchyPage();
    hierarchy = parseHierarchyPage(hierarchyHtml);
    logger.info(`Parsed ${hierarchy.length} hierarchy nodes from remote mirror`);
  } catch (e) {
    logger.warn(`Failed to fetch/parse remote hierarchy.html: ${e}`);
  }

  // 3. Class detail pages (also collect group hrefs seen along the way, so
  //    we can fetch each group page exactly once afterwards for its enums).
  const classes: ClassInfo[] = [];
  const groupUrlByName = new Map<string, string>();
  const ingroupsRe = /<div class="ingroups"><a class="el" href="([^"]+)"[^>]*>([^<]+)<\/a>/;

  let processed = 0;
  const urls = classList.map((e) => ({ name: e.name, url: e.url }));
  for await (const { filename, html } of fetchClassPages(urls)) {
    try {
      // `source` param to parseClassPage only affects the generated docsUrl;
      // classify the real source from the parsed class name (more reliable
      // than the filename) and overwrite it afterwards.
      const classInfo = parseClassPage(html, "enfusion", filename);
      classInfo.source = classifySource(classInfo.name);
      // parseClassPage builds docsUrl against community.bistudio.com's zip
      // layout; for the remote mirror the real reachable page is on
      // arexplorer.zeroy.com itself.
      classInfo.docsUrl = `https://arexplorer.zeroy.com/${filename}`;
      if (classInfo.name) {
        classes.push(classInfo);
      }

      const m = ingroupsRe.exec(html);
      if (m) {
        const [, href, name] = m;
        if (!groupUrlByName.has(name)) {
          groupUrlByName.set(name, href);
        }
      }
    } catch (e) {
      logger.warn(`Failed to parse ${filename}: ${e}`);
    }

    processed++;
    if (processed % 200 === 0) {
      logger.info(`  Parsed ${processed}/${urls.length} class pages from remote mirror...`);
    }
  }
  logger.info(`Parsed ${classes.length} classes from remote mirror`);

  // 4. Group pages (for global/file-scope enums — see doxygen-parser.ts parseGroupPage)
  const classSourceByName = new Map(classes.map((c) => [c.name, c.source]));
  const groups: GroupInfo[] = [];
  const groupUrls = Array.from(groupUrlByName.entries()).map(([name, url]) => ({
    name,
    url,
  }));
  for await (const { html } of fetchClassPages(groupUrls)) {
    try {
      const group = parseGroupPage(html);
      if (!group.name) continue;

      // Best-effort source classification: majority vote among known member classes.
      let armaVotes = 0;
      let enfusionVotes = 0;
      for (const className of group.classes) {
        const src = classSourceByName.get(className);
        if (src === "arma") armaVotes++;
        else if (src === "enfusion") enfusionVotes++;
      }
      group.source = armaVotes > enfusionVotes ? "arma" : "enfusion";

      groups.push(group);
    } catch (e) {
      logger.warn(`Failed to parse remote group page: ${e}`);
    }
  }
  logger.info(`Parsed ${groups.length} groups from remote mirror`);

  const totalEnums = groups.reduce((sum, g) => sum + (g.enums?.length ?? 0), 0);
  logger.info(`Parsed ${totalEnums} group-scope enums from remote mirror`);

  // 5. Cross-reference hierarchy with class data (mutates classes in place)
  crossReferenceHierarchy(classes, hierarchy);

  // Remote mirror does not expose the Page_*.html tutorial pages the local
  // zips have — wiki/tutorial content is out of scope for this source.
  return { classes, groups, hierarchy, wikiPages: [] };
}

export async function scrape(options: ScrapeOptions): Promise<void> {
  logger.info(`Starting scrape (source: ${options.source})`);

  if (options.source === "remote") {
    const result = await scrapeRemoteSource();

    const enfusionClasses = result.classes.filter((c) => c.source === "enfusion");
    const armaClasses = result.classes.filter((c) => c.source === "arma");
    const enfusionGroups = result.groups.filter((g) => g.source === "enfusion");
    const armaGroups = result.groups.filter((g) => g.source === "arma");

    const output: ScrapeOutput = {
      enfusionClasses,
      armaClasses,
      hierarchy: result.hierarchy,
      groups: [...enfusionGroups, ...armaGroups],
      wikiPages: result.wikiPages,
    };

    writeOutput(options.dataDir, output);
    return;
  }

  // Scrape both API sources from local zips
  logger.info("=== Scraping Enfusion Engine API ===");
  const enfusion = scrapeLocalSource(options.workbenchPath, "enfusion");

  logger.info("=== Scraping Arma Reforger API ===");
  const arma = scrapeLocalSource(options.workbenchPath, "arma");

  const output: ScrapeOutput = {
    enfusionClasses: enfusion.classes,
    armaClasses: arma.classes,
    hierarchy: [...enfusion.hierarchy, ...arma.hierarchy],
    groups: [...enfusion.groups, ...arma.groups],
    wikiPages: [...enfusion.wikiPages, ...arma.wikiPages],
  };

  writeOutput(options.dataDir, output);
}
