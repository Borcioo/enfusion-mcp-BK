import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { logger } from "../utils/logger.js";

export interface PatternScript {
  className: string;
  scriptType: string;
  parentClass: string;
  methods: string[];
  description: string;
}

export interface PatternPrefab {
  name: string;
  prefabType: string;
  parentPrefab: string;
  components: Array<{ type: string; properties?: Record<string, string> }>;
  description: string;
}

export interface PatternConfig {
  name: string;
  content: string;
}

export interface PatternCodeExample {
  /** Short label for the operation this snippet demonstrates, e.g. "Update a text widget every frame" */
  title: string;
  /** One or two sentences explaining what the snippet does and where it goes */
  description: string;
  /** 3-15 lines of Enforce Script. Every method/class call must be verified against the API index. */
  code: string;
}

export interface ModPattern {
  name: string;
  description: string;
  tags: string[];
  scripts: PatternScript[];
  prefabs: PatternPrefab[];
  configs: PatternConfig[];
  instructions: string;
  /** Optional short, verified Enforce Script snippets for common operations with this pattern. */
  codeExamples?: PatternCodeExample[];
}

export class PatternLibrary {
  private patterns: Map<string, ModPattern> = new Map();

  constructor(patternsDir: string) {
    this.load(patternsDir);
  }

  private load(dir: string): void {
    if (!existsSync(dir)) {
      logger.debug(`Patterns directory not found: ${dir}`);
      return;
    }

    try {
      const files = readdirSync(dir).filter((f) => extname(f) === ".json");
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), "utf-8");
          const pattern = JSON.parse(raw) as ModPattern;
          const key = basename(file, ".json");
          this.patterns.set(key, pattern);
        } catch (e) {
          logger.warn(`Failed to load pattern ${file}: ${e}`);
        }
      }
      logger.debug(`Loaded ${this.patterns.size} mod patterns`);
    } catch (e) {
      logger.warn(`Failed to read patterns directory: ${e}`);
    }
  }

  get(name: string): ModPattern | undefined {
    return this.patterns.get(name);
  }

  list(): string[] {
    return [...this.patterns.keys()];
  }

  getAll(): ModPattern[] {
    return [...this.patterns.values()];
  }

  /** Get a summary of all patterns for tool descriptions */
  getSummary(): string {
    if (this.patterns.size === 0) return "No patterns loaded.";
    const lines: string[] = [];
    for (const [key, pattern] of this.patterns) {
      lines.push(`- **${key}**: ${pattern.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Build a formatted block of verified code examples across all patterns that have them,
   * for injection into prompt context. Returns an empty string when no pattern has examples.
   */
  getExamplesBlock(): string {
    const sections: string[] = [];
    for (const pattern of this.patterns.values()) {
      if (!pattern.codeExamples || pattern.codeExamples.length === 0) continue;
      for (const example of pattern.codeExamples) {
        sections.push(
          `#### ${pattern.name} — ${example.title}\n${example.description}\n\`\`\`c\n${example.code}\n\`\`\``
        );
      }
    }
    if (sections.length === 0) return "";
    return [
      "### Verified Example Snippets",
      "These snippets use only classes/methods confirmed to exist via api_search. Use them as grounded starting points and adapt to the mod's needs — do not copy blindly, and still verify any additional method you add.",
      "",
      sections.join("\n\n"),
    ].join("\n");
  }
}
