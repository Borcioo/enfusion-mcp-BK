import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname, relative, basename } from "node:path";
import { spawn } from "node:child_process";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import { generateScript } from "../templates/script.js";
import type { PatternLibrary } from "../patterns/loader.js";
import { validateFilename, validateProjectPath } from "../utils/safe-path.js";
import type { SearchEngine } from "../index/search-engine.js";
import { parse, getProperty } from "../formats/enfusion-text.js";
import { formatDryRun, type DryRunFile } from "../utils/dry-run.js";
import { resolveAddonDir, findGproj } from "../utils/game-paths.js";

// ─── build helpers ────────────────────────────────────────────────────────────

const WORKBENCH_DIAG_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const BUILD_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function findWorkbenchExe(workbenchPath: string): string | null {
  // Check Workbench subdirectory first (standard Steam layout: "Arma Reforger Tools/Workbench/")
  const subPath = join(workbenchPath, "Workbench", WORKBENCH_DIAG_EXE);
  if (existsSync(subPath)) return subPath;

  // Check root (in case config points directly to Workbench/)
  const rootPath = join(workbenchPath, WORKBENCH_DIAG_EXE);
  if (existsSync(rootPath)) return rootPath;

  return null;
}

function runBuild(
  exePath: string,
  args: string[],
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const proc = spawn(exePath, args, {
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        stdout,
        stderr: stderr + `\nProcess error: ${err.message}`,
        timedOut: false,
      });
    });
  });
}

// ─── publish helpers ──────────────────────────────────────────────────────────

interface PublishArgsInput {
  gprojPath?: string;
  packDir?: string;
  version?: string;
  changeNote?: string;
  changeNoteFile?: string;
  previewImage?: string;
  screenshotsDir?: string;
  confirmPublish?: boolean;
}

/**
 * Build the ArmaReforgerWorkbenchSteamDiag.exe argv for packing (and, when
 * confirmPublish is true, publishing) an addon via the Workbench CLI.
 *
 * Source: BI Community Wiki, Arma Reforger:Startup Parameters#Workbench
 * (https://community.bistudio.com/wiki/Arma_Reforger:Startup_Parameters)
 *   -wbModule=ResourceManager -packAddon [-packAddonDir <dir>]
 *   -publishAddon [-publishAddonDir <dir>] [-publishAddonVersion <v>]
 *   [-publishAddonChangeNote <note>] [-publishAddonChangeNoteFile <path>]
 *   [-publishAddonPreviewImage <path>] [-publishAddonScreenshots <dir>]
 *   [-gproj <path>]
 *
 * NOTE (documented limitation, same source, Arma_Reforger:Mod_Publishing_Process):
 * -publishAddon "should be used only for publishing addon updates, and not for
 * the initial publish" — there are NO CLI flags for Project Name, Category,
 * Tags, License, Visibility, Summary, or Description. Those fields only exist
 * in the Workbench GUI's "Publish Project" dialog, so a mod's *first* publish
 * always requires a manual GUI step regardless of this tool.
 */
export function buildPublishArgs(input: PublishArgsInput): string[] {
  const args: string[] = ["-wbModule=ResourceManager", "-packAddon"];

  if (input.packDir) {
    args.push("-packAddonDir", input.packDir);
  }

  if (input.confirmPublish) {
    args.push("-publishAddon");
    if (input.packDir) {
      args.push("-publishAddonDir", input.packDir);
    }
    if (input.version) {
      args.push("-publishAddonVersion", input.version);
    }
    if (input.changeNote) {
      args.push("-publishAddonChangeNote", input.changeNote);
    }
    if (input.changeNoteFile) {
      args.push("-publishAddonChangeNoteFile", input.changeNoteFile);
    }
    if (input.previewImage) {
      args.push("-publishAddonPreviewImage", input.previewImage);
    }
    if (input.screenshotsDir) {
      args.push("-publishAddonScreenshots", input.screenshotsDir);
    }
  }

  if (input.gprojPath) {
    args.push("-gproj", input.gprojPath);
  }

  return args;
}

/**
 * Resolve the concrete .gproj file that a publish/pack run must target.
 *
 * The Workbench CLI's -packAddon/-publishAddon flags (unlike -buildData) take
 * no addonName positional argument — the ONLY way to explicitly scope them is
 * -gproj. Without it, they fall back to whatever addon Workbench last had
 * open in its ambient session state, which may not match addonName. To make
 * "publish this addon" safe, we always resolve a concrete .gproj path here
 * and require callers to pass it via -gproj (see buildPublishArgs).
 *
 * Resolution order:
 *  1. Explicit gprojPath — used as-is, no addonName lookup.
 *  2. addonName resolved to an addon directory under config.projectPath
 *     (resolveAddonDir), then to a .gproj inside it (findGproj).
 *
 * Returns an error string (never throws) when the target cannot be resolved,
 * so the caller can report a clear error before attempting any spawn.
 */
function resolvePublishTarget(
  config: Config,
  addonName: string,
  gprojPath?: string
): { gproj: string } | { error: string } {
  if (gprojPath) {
    return { gproj: gprojPath };
  }

  const addonDir = resolveAddonDir(config.projectPath, addonName);
  if (!addonDir) {
    return {
      error:
        `Could not find addon directory for '${addonName}' under ${config.projectPath}. ` +
        "Provide an explicit gprojPath, or ensure addonName matches the addon's folder name.",
    };
  }

  const gproj = findGproj(addonDir);
  if (!gproj) {
    return {
      error:
        `Found addon directory for '${addonName}' at ${addonDir}, but no .gproj file inside it ` +
        "(checked the root and one level of subdirectories). Provide an explicit gprojPath.",
    };
  }

  return { gproj };
}

// ─── create helpers ───────────────────────────────────────────────────────────

/**
 * Derive a 2-4 character prefix from the mod name.
 * "MyCustomMod" → "MCM", "ZombieDefense" → "ZD"
 */
function derivePrefix(name: string): string {
  // Extract uppercase letters
  const uppers = name.replace(/[^A-Z]/g, "");
  if (uppers.length >= 2 && uppers.length <= 4) return uppers;
  if (uppers.length > 4) return uppers.slice(0, 3);

  // Fallback: first 3 chars uppercased
  return name.slice(0, 3).toUpperCase();
}

// ─── validate helpers ─────────────────────────────────────────────────────────

/**
 * A structured, machine-executable fix suggestion for a ValidationIssue.
 * Only attached when the correct remediation is unambiguous and mechanically
 * derivable from the violation itself — never fabricated. Callers/agents can
 * pattern-match on `action` to apply the fix programmatically instead of
 * parsing the human-readable `message`.
 */
export type FixAction =
  | { action: "move"; from: string; to: string }
  | { action: "create"; path: string; contentHint: string }
  | { action: "setField"; file: string; field: string; value: string }
  | { action: "addDependency"; gproj: string; dependency: string }
  | { action: "rename"; from: string; to: string };

export interface ValidationIssue {
  level: "error" | "warning" | "info";
  message: string;
  /** Structured fix suggestion, present only when mechanically derivable. */
  fix?: FixAction;
}

type CheckName = "structure" | "gproj" | "scripts" | "prefabs" | "configs" | "references" | "naming";

const ALL_CHECKS: CheckName[] = ["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"];

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const walk = (current: string) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extname(entry.name).toLowerCase() === ext) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };
  walk(dir);
  return results;
}

export function checkStructure(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check for .gproj file
  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) {
    // No unambiguous fix: we can't derive a correct ID/GUID/TITLE for a
    // project file that doesn't exist yet.
    issues.push({ level: "error", message: "No .gproj file found in project root" });
  } else if (gprojFiles.length > 1) {
    // Ambiguous which file is the "real" one — no fix.
    issues.push({ level: "warning", message: `Multiple .gproj files found: ${gprojFiles.join(", ")}` });
  }

  // Check standard directories
  const expectedDirs = ["Scripts/Game"];
  for (const dir of expectedDirs) {
    if (!existsSync(resolve(projectPath, dir))) {
      issues.push({
        level: "warning",
        message: `Missing expected directory: ${dir}`,
        fix: { action: "create", path: dir, contentHint: "empty directory for Game module scripts" },
      });
    }
  }

  return issues;
}

const BASE_GAME_DEPENDENCY = "58D0FB3206B6F859";

export function checkGproj(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) return issues;

  for (const filename of gprojFiles) {
    const filepath = resolve(projectPath, filename);
    try {
      const content = readFileSync(filepath, "utf-8");
      const node = parse(content);

      if (node.type !== "GameProject") {
        // We don't know what the correct root node type should be — no fix.
        issues.push({ level: "error", message: `${filename}: Root node is "${node.type}", expected "GameProject"` });
      }

      const id = getProperty(node, "ID");
      if (!id) {
        // Derivable: the ID conventionally matches the .gproj filename.
        const derivedId = filename.slice(0, -extname(filename).length);
        issues.push({
          level: "error",
          message: `${filename}: Missing ID field`,
          fix: { action: "setField", file: filename, field: "ID", value: derivedId },
        });
      }

      const guid = getProperty(node, "GUID");
      if (!guid) {
        // No mechanically "correct" GUID exists — any freshly generated one
        // would work, so there's nothing unambiguous to suggest.
        issues.push({ level: "error", message: `${filename}: Missing GUID field` });
      } else if (typeof guid === "string" && !/^[0-9A-Fa-f]{16}$/.test(guid)) {
        issues.push({ level: "warning", message: `${filename}: GUID "${guid}" is not a valid 16-char hex string` });
      }

      const deps = node.children.find((c) => c.type === "Dependencies");
      if (!deps) {
        issues.push({
          level: "error",
          message: `${filename}: Missing Dependencies block — mod won't load`,
          fix: { action: "addDependency", gproj: filename, dependency: BASE_GAME_DEPENDENCY },
        });
      } else if (!deps.values.includes(BASE_GAME_DEPENDENCY)) {
        issues.push({
          level: "error",
          message: `${filename}: Missing base game dependency (${BASE_GAME_DEPENDENCY})`,
          fix: { action: "addDependency", gproj: filename, dependency: BASE_GAME_DEPENDENCY },
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ level: "error", message: `${filename}: Failed to parse — ${msg}` });
    }
  }

  return issues;
}

export function checkScripts(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Find all .c files in the project
  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    // Check if script is in a valid module folder
    if (!rel.startsWith("Scripts/Game/") && !rel.startsWith("Scripts/GameLib/") && !rel.startsWith("Scripts/WorkbenchGame/")) {
      // Derivable: default target module is Scripts/Game/ (the primary
      // gameplay-code module). Only the basename is used — we don't know
      // whether any subdirectory structure outside Scripts/ was meaningful.
      const to = `Scripts/Game/${basename(rel)}`;
      issues.push({
        level: "error",
        message: `${rel}: Script is outside a valid module folder (Scripts/Game/, Scripts/GameLib/, Scripts/WorkbenchGame/) — it will be silently ignored`,
        fix: { action: "move", from: rel, to },
      });
      continue;
    }

    // Basic syntax check: look for class declaration
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const hasClass = /\b(class|modded\s+class)\s+\w+/.test(content);
      if (!hasClass) {
        issues.push({
          level: "warning",
          message: `${rel}: No class declaration found`,
        });
      }
    } catch {
      issues.push({
        level: "warning",
        message: `${rel}: Could not read file`,
      });
    }
  }

  return issues;
}

export function checkPrefabs(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allPrefabs = findFiles(projectPath, ".et");

  for (const prefabPath of allPrefabs) {
    const rel = relative(projectPath, prefabPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(prefabPath, "utf-8");
      parse(content); // Just verify it parses
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid prefab format — ${msg}`,
      });
    }
  }

  return issues;
}

export function checkConfigs(projectPath: string, searchEngine?: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allConfigs = findFiles(projectPath, ".conf");

  for (const configPath of allConfigs) {
    const rel = relative(projectPath, configPath).replace(/\\/g, "/");
    try {
      const content = readFileSync(configPath, "utf-8");
      const root = parse(content);

      // Check root node type against API index (only if searchEngine available)
      if (searchEngine && root.type && !searchEngine.hasClass(root.type)) {
        issues.push({
          level: "warning",
          message: `${rel}: Root class "${root.type}" not found in API index — may be from another mod or misspelled.`,
        });
      }

      // Walk children and check their type names
      if (searchEngine) {
        const walkNodes = (node: ReturnType<typeof parse>) => {
          for (const child of node.children || []) {
            if (child.type && /^[A-Z]/.test(child.type) && !searchEngine.hasClass(child.type)) {
              issues.push({
                level: "warning",
                message: `${rel}: Class "${child.type}" not found in API index.`,
              });
            }
            walkNodes(child);
          }
        };
        walkNodes(root);
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid config format — ${msg}`,
      });
    }
  }

  return issues;
}

export function checkReferences(projectPath: string, searchEngine: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(scriptPath, "utf-8");

      // Extract parent class from class declarations
      const classMatch = content.match(/(?:modded\s+)?class\s+\w+\s*:\s*(\w+)/);
      if (classMatch) {
        const parentClass = classMatch[1];
        if (!searchEngine.hasClass(parentClass)) {
          issues.push({
            level: "warning",
            message: `${rel}: Extends "${parentClass}" which is not in the API index (may be from another mod)`,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return issues;
}

export function checkNaming(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");
  const prefixCounts: Map<string, number> = new Map();
  const classInfo: Array<{ rel: string; className: string; prefix: string; rest: string }> = [];

  for (const scriptPath of allScripts) {
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const classMatch = content.match(/(?:modded\s+)?class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        // Extract prefix (part before first underscore)
        const prefixMatch = className.match(/^([A-Z]+)_(.+)$/);
        if (prefixMatch) {
          const prefix = prefixMatch[1];
          const rest = prefixMatch[2];
          prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
          classInfo.push({
            rel: relative(projectPath, scriptPath).replace(/\\/g, "/"),
            className,
            prefix,
            rest,
          });
        }
      }
    } catch {
      // Skip
    }
  }

  // Find the most common prefix
  if (prefixCounts.size > 1) {
    let maxPrefix = "";
    let maxCount = 0;
    for (const [prefix, count] of prefixCounts) {
      if (count > maxCount) {
        maxPrefix = prefix;
        maxCount = count;
      }
    }

    for (const info of classInfo) {
      if (info.prefix !== maxPrefix) {
        // Derivable: rename to the majority prefix, keeping the class's own suffix.
        const to = `${maxPrefix}_${info.rest}`;
        issues.push({
          level: "info",
          message: `${info.rel}: Class "${info.className}" uses prefix "${info.prefix}_" instead of the most common prefix "${maxPrefix}_"`,
          fix: { action: "rename", from: info.className, to },
        });
      }
    }
  }

  return issues;
}

// ─── registerMod ──────────────────────────────────────────────────────────────

export function registerMod(
  server: McpServer,
  config: Config,
  searchEngine: SearchEngine,
  patterns: PatternLibrary
): void {
  server.registerTool(
    "mod",
    {
      description:
        "Manage Arma Reforger addons: build with the Workbench CLI, scaffold a new addon, validate an existing addon without building, or pack/publish to the Steam Workshop. action='create' supports dryRun to preview the scaffold without writing. " +
        "action='publish' resolves addonName to a concrete .gproj (or uses an explicit gprojPath) and always passes -gproj, so it never falls back to Workbench's ambient last-open-session addon. Unless dryRun=true, it runs a real -packAddon spawn (packing is not irreversible); it additionally uploads via -publishAddon only when confirmPublish=true. IMPORTANT: a mod's first-ever publish (Project Name, Category, Tags, License, Visibility, Summary, Description) has no CLI equivalent and MUST be done once via Workbench > Publish Project GUI — this action only automates packing and subsequent version updates. " +
        "If ENFUSION_PROJECT_PATH points to a multi-mod workspace (a directory containing several addon folders), action='validate' accepts modName to scope validation to a specific addon. " +
        "action='validate' also returns structuredContent.issues[], where each issue may carry a machine-executable fix object (e.g. {action:'move', from, to}, {action:'addDependency', gproj, dependency}) for issues with an unambiguous, mechanically-derivable remediation — fix is omitted when no single correct answer exists (e.g. a missing GUID).",
      inputSchema: {
        action: z
          .enum(["build", "create", "validate", "publish"])
          .describe("Action to perform: 'build' compiles the addon, 'create' scaffolds a new addon, 'validate' checks an existing addon, 'publish' packs (and optionally uploads) the addon via the Workbench CLI."),

        // ── build params ──────────────────────────────────────────────────────
        addonName: z
          .string()
          .min(1)
          .optional()
          .describe(
            "(build/publish) Name of the addon (must match the .gproj ID). " +
            "(publish) Resolved to a concrete .gproj under the configured project path (or overridden by gprojPath); required so publish always targets an explicit addon."
          ),
        platform: z
          .enum(["PC", "PC_WB", "HEADLESS"])
          .default("PC")
          .optional()
          .describe("(build) Target platform for the build"),
        outputPath: z
          .string()
          .optional()
          .describe("(build) Build output directory. Auto-generated if omitted."),
        gprojPath: z
          .string()
          .optional()
          .describe(
            "(build) Path to .gproj file. Auto-detected if omitted. " +
            "(publish) Explicit .gproj path; when omitted, derived from addonName under the configured project path. Always passed as -gproj so publish never relies on Workbench's ambient session state."
          ),
        filterPath: z
          .string()
          .optional()
          .describe("(build) Limit build to a single folder or file for faster iteration"),

        // ── create params ─────────────────────────────────────────────────────
        name: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("(create) Addon name (e.g., 'MyCustomMod'). Used as the project folder name."),
        description: z
          .string()
          .optional()
          .describe("(create) Brief description of what the mod does"),
        prefix: z
          .string()
          .min(1)
          .max(4)
          .optional()
          .describe("(create) Class name prefix (e.g., 'MCM'). Auto-derived from name if omitted."),
        pattern: z
          .string()
          .optional()
          .describe("(create) Mod pattern to apply (e.g., 'custom-faction', 'game-mode'). Use without this to get a bare scaffold."),
        projectPath: z
          .string()
          .optional()
          .describe("(create/validate) Parent directory where the addon folder will be created (create), or addon root directory (validate). Uses configured default if omitted."),

        // ── validate params ───────────────────────────────────────────────────
        checks: z
          .array(z.enum(["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"]))
          .optional()
          .describe("(validate) Specific checks to run. Runs all checks if omitted."),
        modName: z
          .string()
          .optional()
          .describe(
            "(validate) Addon folder name under ENFUSION_PROJECT_PATH when it points to a multi-mod workspace " +
            "(e.g., 'MyMod'). Scopes validation to that addon. If omitted, falls back to the configured default " +
            "mod (ENFUSION_DEFAULT_MOD), or the configured project path itself. Ignored when 'projectPath' is " +
            "explicitly provided."
          ),

        // ── create params (continued) ─────────────────────────────────────────
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            "(create) Preview what would be created/written without touching disk — returns the target paths and content instead of writing. " +
            "(publish) Also gates 'publish': when true, only the pack+publish command is returned as a preview and nothing is executed."
          ),

        // ── publish params ────────────────────────────────────────────────────
        packDir: z
          .string()
          .optional()
          .describe("(publish) Output directory for the packed addon data (-packAddonDir). Uses the last Workbench session's directory if omitted."),
        version: z
          .string()
          .optional()
          .describe("(publish) Mod version to publish (-publishAddonVersion, e.g. '1.2.0'). If omitted, the backend auto-increments the latest published version."),
        changeNote: z
          .string()
          .optional()
          .describe("(publish) Change note text for this update (-publishAddonChangeNote)."),
        changeNoteFile: z
          .string()
          .optional()
          .describe("(publish) Path to a file containing the change note (-publishAddonChangeNoteFile). Alternative to changeNote."),
        previewImage: z
          .string()
          .optional()
          .describe("(publish) Path to a preview image, JPG or PNG, max 2MB (-publishAddonPreviewImage)."),
        screenshotsDir: z
          .string()
          .optional()
          .describe("(publish) Directory of screenshots (jpg/png/bmp) to upload (-publishAddonScreenshots)."),
        confirmPublish: z
          .boolean()
          .default(false)
          .describe(
            "(publish) Must be explicitly set to true to actually run -publishAddon and upload to the Steam Workshop (a real, irreversible network action). " +
            "Without it, 'publish' still runs the real (non-irreversible) -packAddon step unless dryRun=true, but never uploads."
          ),
      },
    },
    async ({
      action,
      addonName,
      platform,
      outputPath,
      gprojPath,
      filterPath,
      name,
      description,
      prefix,
      pattern: patternName,
      projectPath,
      checks,
      modName,
      dryRun,
      packDir,
      version,
      changeNote,
      changeNoteFile,
      previewImage,
      screenshotsDir,
      confirmPublish,
    }) => {

      // ── build ──────────────────────────────────────────────────────────────
      if (action === "build") {
        if (!addonName) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'build': addonName" }],
            isError: true,
          };
        }

        const exePath = findWorkbenchExe(config.workbenchPath);
        if (!exePath) {
          return {
            content: [
              {
                type: "text",
                text: `Workbench not found at: ${config.workbenchPath}\n\n${WORKBENCH_DIAG_EXE} is required for building.\n\nInstall Arma Reforger Tools from Steam, or set ENFUSION_WORKBENCH_PATH to the correct path.\n\nNote: You need the Diag version (opt into "Profiling Build" beta in Steam).`,
              },
            ],
            isError: true,
          };
        }

        const buildOutput =
          outputPath ||
          resolve(config.workbenchPath, "addons", addonName, "output");

        const args: string[] = [
          "-wbModule=ResourceManager",
          `-buildData`,
          platform ?? "PC",
          buildOutput,
          addonName,
        ];

        if (gprojPath) {
          args.push(`-gproj`, gprojPath);
        }

        if (filterPath) {
          args.push(`-filterPath`, filterPath);
        }

        try {
          const startTime = Date.now();
          const result = await runBuild(exePath, args, BUILD_TIMEOUT_MS);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          const lines: string[] = [];
          lines.push(`## Build Result: ${addonName}`);
          lines.push("");

          if (result.timedOut) {
            lines.push(`**Status:** TIMEOUT (exceeded ${BUILD_TIMEOUT_MS / 1000}s limit)`);
            lines.push("The build process was killed. Try building a smaller scope with filterPath.");
          } else if (result.exitCode === 0) {
            lines.push("**Status:** SUCCESS");
            lines.push(`**Build time:** ${elapsed}s`);
            lines.push(`**Output:** ${buildOutput}`);
          } else {
            lines.push(`**Status:** FAILED (exit code ${result.exitCode})`);
            lines.push(`**Build time:** ${elapsed}s`);
          }

          lines.push("");
          lines.push(`**Command:** ${WORKBENCH_DIAG_EXE} ${args.join(" ")}`);

          if (result.stdout.trim()) {
            lines.push("");
            lines.push("### Output");
            lines.push("```");
            const stdoutLines = result.stdout.trim().split("\n");
            const shown = stdoutLines.slice(-100);
            if (stdoutLines.length > 100) {
              lines.push(`... (${stdoutLines.length - 100} lines omitted)`);
            }
            lines.push(shown.join("\n"));
            lines.push("```");
          }

          if (result.stderr.trim()) {
            lines.push("");
            lines.push("### Errors");
            lines.push("```");
            const stderrLines = result.stderr.trim().split("\n");
            const shown = stderrLines.slice(-50);
            if (stderrLines.length > 50) {
              lines.push(`... (${stderrLines.length - 50} lines omitted)`);
            }
            lines.push(shown.join("\n"));
            lines.push("```");
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error running build: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── publish ────────────────────────────────────────────────────────────
      if (action === "publish") {
        if (!addonName) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'publish': addonName" }],
            isError: true,
          };
        }

        // Resolve a concrete .gproj target BEFORE building argv or spawning anything.
        // -packAddon/-publishAddon have no addonName positional arg — only -gproj can
        // scope them — so an unresolved target must hard-fail here rather than silently
        // falling back to whatever addon Workbench's ambient session last had open.
        const target = resolvePublishTarget(config, addonName, gprojPath);
        if ("error" in target) {
          return {
            content: [{ type: "text", text: `Could not resolve publish target for '${addonName}': ${target.error}` }],
            isError: true,
          };
        }
        const resolvedGproj = target.gproj;

        const args = buildPublishArgs({
          gprojPath: resolvedGproj,
          packDir,
          version,
          changeNote,
          changeNoteFile,
          previewImage,
          screenshotsDir,
          confirmPublish,
        });
        const commandStr = `${WORKBENCH_DIAG_EXE} ${args.join(" ")}`;

        const manualStepsNote =
          "### First-time publish — manual GUI step required\n" +
          "The Workbench CLI has no flags for Project Name, Category, Tags, License, Visibility, Summary, or Description. " +
          "-publishAddon is documented (BI wiki) to be for *updating* an already-published mod, not the initial publish. " +
          "For the first publish of this addon, open it in Workbench and use **Workbench > Publish Project** to set those fields once. " +
          "After that, this tool can drive subsequent version updates (pack + -publishAddon) headlessly.";

        const lines: string[] = [];
        lines.push(`## Publish: ${addonName}`);
        lines.push("");
        lines.push(`**Target:** ${resolvedGproj}`);
        lines.push(`**Command:** ${commandStr}`);
        lines.push("");
        lines.push(manualStepsNote);

        if (dryRun) {
          lines.push("");
          lines.push("**Status:** DRY RUN — nothing was executed.");
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Packing (-packAddon) builds the publishable output and is NOT irreversible —
        // it runs for real here even without confirmPublish. Only -publishAddon (the
        // actual Steam Workshop upload, added above by buildPublishArgs) is gated on
        // confirmPublish=true.
        lines.push("");
        lines.push(
          confirmPublish
            ? "**Intent:** pack + publish (upload) — confirmPublish=true."
            : "**Intent:** pack only — no upload. Set confirmPublish=true to also run -publishAddon and upload to the Steam Workshop " +
              "(only after the first-time GUI publish above has been done)."
        );

        const exePath = findWorkbenchExe(config.workbenchPath);
        if (!exePath) {
          lines.push("");
          lines.push(
            `**Status:** ERROR — Workbench not found at: ${config.workbenchPath}\n\n${WORKBENCH_DIAG_EXE} is required for publishing.\n\nInstall Arma Reforger Tools from Steam, or set ENFUSION_WORKBENCH_PATH to the correct path.\n\nNote: You need the Diag version (opt into "Profiling Build" beta in Steam).`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
        }

        try {
          const startTime = Date.now();
          const result = await runBuild(exePath, args, BUILD_TIMEOUT_MS);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const ranWhat = confirmPublish ? "packed and published" : "packed (not published)";

          if (result.timedOut) {
            lines.push("");
            lines.push(`**Status:** TIMEOUT (exceeded ${BUILD_TIMEOUT_MS / 1000}s limit)`);
          } else if (result.exitCode === 0) {
            lines.push("");
            lines.push(`**Status:** SUCCESS — ${ranWhat}.`);
            lines.push(`**Elapsed:** ${elapsed}s`);
          } else {
            lines.push("");
            lines.push(`**Status:** FAILED (exit code ${result.exitCode})`);
            lines.push(`**Elapsed:** ${elapsed}s`);
          }

          if (result.stdout.trim()) {
            lines.push("");
            lines.push("### Output");
            lines.push("```");
            const stdoutLines = result.stdout.trim().split("\n");
            const shown = stdoutLines.slice(-100);
            if (stdoutLines.length > 100) {
              lines.push(`... (${stdoutLines.length - 100} lines omitted)`);
            }
            lines.push(shown.join("\n"));
            lines.push("```");
          }

          if (result.stderr.trim()) {
            lines.push("");
            lines.push("### Errors");
            lines.push("```");
            const stderrLines = result.stderr.trim().split("\n");
            const shown = stderrLines.slice(-50);
            if (stderrLines.length > 50) {
              lines.push(`... (${stderrLines.length - 50} lines omitted)`);
            }
            lines.push(shown.join("\n"));
            lines.push("```");
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error running publish: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── create ─────────────────────────────────────────────────────────────
      if (action === "create") {
        if (!name) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'create': name" }],
            isError: true,
          };
        }

        const basePath = projectPath || config.projectPath;

        if (!basePath) {
          return {
            content: [
              {
                type: "text",
                text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
              },
            ],
            isError: true,
          };
        }

        try {
          validateFilename(name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid addon name: ${msg}` }],
            isError: true,
          };
        }

        // Validate pattern before creating any directories
        if (patternName) {
          const patternDef = patterns.get(patternName);
          if (!patternDef) {
            const available = patterns.list().join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown pattern: "${patternName}"\nAvailable patterns: ${available}`,
                },
              ],
            };
          }
        }

        const addonDir = resolve(basePath, name);
        const classPrefix = prefix ?? derivePrefix(name);

        if (existsSync(addonDir)) {
          return {
            content: [
              {
                type: "text",
                text: `Directory already exists: ${addonDir}\nUse a different name or delete the existing directory.`,
              },
            ],
          };
        }

        try {
          const createdFiles: string[] = [];
          const plannedFiles: DryRunFile[] = [];

          // Create directory structure
          const dirs = [
            addonDir,
            join(addonDir, "Scripts", "Game"),
            join(addonDir, "Prefabs"),
            join(addonDir, "PrefabsEditable"),
            join(addonDir, "Configs"),
            join(addonDir, "Language"),
            join(addonDir, "Missions"),
            join(addonDir, "UI"),
            join(addonDir, "Worlds"),
          ];
          if (!dryRun) {
            for (const dir of dirs) {
              mkdirSync(dir, { recursive: true });
            }
          }

          // Generate and (unless dryRun) write .gproj
          const gprojContent = generateGproj({
            name,
            title: name,
          });
          const gprojFilePath = join(addonDir, `${name}.gproj`);
          if (!dryRun) writeFileSync(gprojFilePath, gprojContent, "utf-8");
          createdFiles.push(`${name}.gproj`);
          plannedFiles.push({ path: gprojFilePath, content: gprojContent });

          // Apply pattern if specified (already validated above)
          if (patternName) {
            const patternDef = patterns.get(patternName)!;

            // Check for filename collisions after prefix replacement
            const scriptPaths: string[] = [];
            for (const scriptDef of patternDef.scripts) {
              const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
              const path = `Scripts/Game/${className}.c`;
              if (scriptPaths.includes(path)) {
                return {
                  content: [{
                    type: "text",
                    text: `Pattern "${patternName}" produces duplicate script file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                  }],
                };
              }
              scriptPaths.push(path);
            }

            const configPaths: string[] = [];
            for (const configDef of patternDef.configs) {
              const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
              const path = `Configs/${configName}.conf`;
              if (configPaths.includes(path)) {
                return {
                  content: [{
                    type: "text",
                    text: `Pattern "${patternName}" produces duplicate config file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                  }],
                };
              }
              configPaths.push(path);
            }

            // Generate scripts from pattern
            for (const scriptDef of patternDef.scripts) {
              const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
              const code = generateScript({
                className,
                scriptType: scriptDef.scriptType as any,
                parentClass: scriptDef.parentClass || undefined,
                methods: scriptDef.methods.length > 0 ? scriptDef.methods : undefined,
                description: scriptDef.description,
              });
              const scriptPath = join(addonDir, "Scripts", "Game", `${className}.c`);
              if (!dryRun) writeFileSync(scriptPath, code, "utf-8");
              createdFiles.push(`Scripts/Game/${className}.c`);
              plannedFiles.push({ path: scriptPath, content: code });
            }

            // Create prefab subdirectories from pattern
            for (const prefabDef of patternDef.prefabs) {
              const prefabName = prefabDef.name.replace(/\{PREFIX\}/g, classPrefix);
              // Ensure directory exists (prefabs go in type-specific subdirs)
              const prefabDir = join(addonDir, "Prefabs");
              if (!dryRun) mkdirSync(prefabDir, { recursive: true });
              // Note: prefab file generation is done via prefab_create tool for full control
              createdFiles.push(`(Use prefab_create for: ${prefabName})`);
            }

            // Apply pattern configs
            for (const configDef of patternDef.configs) {
              const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
              const configContent = configDef.content.replace(/\{PREFIX\}/g, classPrefix);
              const targetPath = join(addonDir, "Configs", `${configName}.conf`);
              if (!dryRun) {
                mkdirSync(resolve(targetPath, ".."), { recursive: true });
                writeFileSync(targetPath, configContent, "utf-8");
              }
              createdFiles.push(`Configs/${configName}.conf`);
              plannedFiles.push({ path: targetPath, content: configContent });
            }
          }

          if (dryRun) {
            const previewFiles: DryRunFile[] = [
              ...dirs.map((d) => ({ path: d })),
              ...plannedFiles,
            ];
            return {
              content: [
                {
                  type: "text",
                  text: formatDryRun(
                    previewFiles,
                    `Addon scaffold preview for "${name}" — nothing was written.`
                  ),
                },
              ],
            };
          }

          // Build response
          const lines: string[] = [];
          lines.push(`## Addon Created: ${name}`);
          lines.push(`Path: ${addonDir}`);
          lines.push(`Class prefix: ${classPrefix}`);
          lines.push("");
          lines.push("### Created Files");
          for (const f of createdFiles) {
            lines.push(`- ${f}`);
          }
          lines.push("");
          lines.push("### Directory Structure");
          lines.push(`${name}/`);
          lines.push(`  ${name}.gproj`);
          lines.push("  Scripts/");
          lines.push("    Game/");
          if (createdFiles.some((f) => f.startsWith("Scripts/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Scripts/Game/")) {
                lines.push(`      ${f.replace("Scripts/Game/", "")}`);
              }
            }
          }
          lines.push("  Prefabs/");
          lines.push("  PrefabsEditable/");
          lines.push("  Configs/");
          if (createdFiles.some((f) => f.startsWith("Configs/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Configs/")) {
                lines.push(`    ${f.replace("Configs/", "")}`);
              }
            }
          }
          lines.push("  Language/");
          lines.push("  Missions/");
          lines.push("  UI/");
          lines.push("  Worlds/");
          lines.push("");
          lines.push("Addon scaffold is ready. Proceeding with file generation and Workbench integration automatically.");

          if (patternName) {
            const patternDef = patterns.get(patternName);
            if (patternDef?.instructions) {
              lines.push("");
              lines.push("### Pattern Instructions");
              lines.push(patternDef.instructions);
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error creating addon: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── validate ───────────────────────────────────────────────────────────
      // action === "validate"
      // Resolve the addon directory to validate.
      // Precedence: explicit projectPath override > modName (multi-mod workspace) >
      // configured defaultMod > configured projectPath (original single-mod behavior).
      let basePath: string;
      if (projectPath) {
        // Validate user-supplied path is within the configured project directory
        try {
          basePath = validateProjectPath(config.projectPath, projectPath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Invalid project path: "${projectPath}". Path must be within the configured project directory (${config.projectPath}).`,
              },
            ],
          };
        }
      } else if (modName) {
        const addonDir = resolveAddonDir(config.projectPath, modName);
        if (!addonDir) {
          return {
            content: [
              {
                type: "text",
                text: `Could not find addon directory. '${modName}' not found under ${config.projectPath}. Provide modName matching the addon folder name.`,
              },
            ],
            isError: true,
          };
        }
        basePath = addonDir;
      } else if (config.defaultMod) {
        basePath = resolveAddonDir(config.projectPath, config.defaultMod) ?? config.projectPath;
      } else {
        // Deliberate exception: when neither modName nor defaultMod is set, this falls
        // through to the raw config.projectPath rather than auto-detecting the first
        // .gproj addon (which is what game-duplicate.ts / wb-entity-duplicate.ts do via
        // resolveAddonDir(projectPath) with no modName). That auto-detect scans child
        // directories for a .gproj, which would break the legacy "single addon lives
        // directly at projectPath, no multi-mod subfolders" layout. Keeping the plain
        // fallback here preserves backward compatibility for that layout.
        basePath = config.projectPath;
      }

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(basePath)) {
        return {
          content: [
            { type: "text", text: `Project directory not found: ${basePath}` },
          ],
          isError: true,
        };
      }

      const enabledChecks = (checks as CheckName[] | undefined) ?? ALL_CHECKS;
      const allIssues: ValidationIssue[] = [];

      const checkMap: Record<CheckName, () => ValidationIssue[]> = {
        structure: () => checkStructure(basePath),
        gproj: () => checkGproj(basePath),
        scripts: () => checkScripts(basePath),
        prefabs: () => checkPrefabs(basePath),
        configs: () => checkConfigs(basePath, searchEngine),
        references: () => checkReferences(basePath, searchEngine),
        naming: () => checkNaming(basePath),
      };

      const passedChecks: string[] = [];

      for (const check of enabledChecks) {
        const issues = checkMap[check]();
        if (issues.length === 0) {
          passedChecks.push(check);
        }
        allIssues.push(...issues);
      }

      // Format report
      const errors = allIssues.filter((i) => i.level === "error");
      const warnings = allIssues.filter((i) => i.level === "warning");
      const infos = allIssues.filter((i) => i.level === "info");
      const fixableCount = allIssues.filter((i) => i.fix).length;

      const formatIssue = (i: ValidationIssue): string =>
        i.fix ? `- ${i.message} [fix: ${JSON.stringify(i.fix)}]` : `- ${i.message}`;

      const lines: string[] = [];
      const dirName = basePath.split(/[\\/]/).pop() || basePath;
      lines.push(`## Validation Report: ${dirName}`);
      lines.push("");

      if (errors.length > 0) {
        lines.push(`### Errors (${errors.length})`);
        for (const e of errors) lines.push(formatIssue(e));
        lines.push("");
      }

      if (warnings.length > 0) {
        lines.push(`### Warnings (${warnings.length})`);
        for (const w of warnings) lines.push(formatIssue(w));
        lines.push("");
      }

      if (infos.length > 0) {
        lines.push(`### Info (${infos.length})`);
        for (const i of infos) lines.push(formatIssue(i));
        lines.push("");
      }

      if (passedChecks.length > 0) {
        lines.push(`### Passed (${passedChecks.length})`);
        for (const c of passedChecks) lines.push(`- ${c}`);
        lines.push("");
      }

      if (errors.length === 0 && warnings.length === 0) {
        lines.push("All checks passed!");
      }

      if (fixableCount > 0) {
        lines.push(
          `${fixableCount} issue(s) include a structured, machine-executable fix suggestion (see structuredContent.issues[].fix).`
        );
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { issues: allIssues },
      };
    }
  );
}
