# enfusion-mcp

MCP server for Arma Reforger modding. Describe what you want to build, and Claude handles everything — API research, code generation, project scaffolding, Workbench control, and in-editor testing. Zero modding experience required.

## Install

### Claude Code (Windows)

```bash
claude mcp add --scope user enfusion-mcp -- cmd /c npx -y enfusion-mcp
```

### Claude Code (macOS / Linux)

```bash
claude mcp add --scope user enfusion-mcp -- npx -y enfusion-mcp
```

Restart Claude Code. Verify with `/mcp`.

### Claude Desktop

Add to your `claude_desktop_config.json`:

**Windows:**

```json
{
  "mcpServers": {
    "enfusion-mcp": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "enfusion-mcp"]
    }
  }
}
```

**macOS / Linux:**

```json
{
  "mcpServers": {
    "enfusion-mcp": {
      "command": "npx",
      "args": ["-y", "enfusion-mcp"]
    }
  }
}
```

Restart Claude Desktop. Verify with `/mcp`.

### Workbench Plugin

The live Workbench tools (`wb_*`) require handler scripts running inside Workbench. These ship with the package in `mod/Scripts/WorkbenchGame/EnfusionMCP/` and are installed automatically when Claude launches Workbench via `wb_launch`.

## Usage

Just ask Claude to make a mod:

- *"Create a HUD widget that shows player health and stamina"*
- *"Make a zombie survival game mode with wave spawning"*
- *"Create a custom faction called CSAT with desert camo soldiers"*
- *"Add an interactive object that heals the player when used"*
- *"Override the damage system to add armor mechanics"*

Or use the guided prompts for structured workflows:

| Prompt | Description |
|--------|-------------|
| `/create-mod` | Full guided mod creation — from idea to built addon |
| `/modify-mod` | Modify or extend an existing mod project |

Claude will:

1. **Assess complexity** — simple mods are built in one pass; large mods (e.g., a DayZ-style overhaul) get broken into phases with a plan you approve before any code is written
2. **Research** the Enfusion API (8,693 indexed classes), the Arma Reforger wiki (250+ guides), and base game assets (read directly from `.pak` archives) to find the right approach
3. **Scaffold** the full addon — `.gproj`, scripts, prefabs, configs, UI layouts
4. **Launch Workbench** if it's not already running
5. **Load the project**, reload scripts, register resources
6. **Validate and build** the addon
7. **Enter play mode** so you can test in-game

For complex mods, a `MODPLAN.md` is written to the project root tracking the full vision, completed phases, and what's next — so any future session can pick up right where the last one left off via `/modify-mod`.

## Tools

### Offline Tools

Work without Workbench running — API search, mod scaffolding, code generation, validation, and building.

| Tool | What it does |
|------|-------------|
| `api_search` | Search 8,693 Enfusion/Arma Reforger API classes and methods — includes inherited members, enum-like class detection, related sibling classes, and `format: 'tree'` for ASCII inheritance hierarchy visualization |
| `component_search` | Search ScriptComponent descendants — filter by category (character, vehicle, weapon, damage, inventory, ai, ui, etc.) and event handlers |
| `script_check` | Validate a class + method before writing script that calls it — inheritance-aware (finds methods declared on parent classes and names the declaring class), with fuzzy "did you mean" suggestions for typos and unknown classes |
| `wiki_search` | Search 250+ tutorials and guides from the Enfusion engine docs and BI Community Wiki |
| `wiki_read` | Read the full content of a wiki page by title — no truncation, includes code examples |
| `wb_knowledge` | Search the bundled Arma Reforger modding knowledge base — distilled patterns covering scripting, audio, weapons, vehicles, AI, UI, game modes, animation, and more |
| `game_browse` | Browse base game files — loose files and `.pak` archives transparently |
| `game_read` | Read base game files — scripts, prefabs, configs from loose files or `.pak` |
| `prefab_inspect` | Inspect a prefab's full inheritance chain — merges all components across ancestors, showing which level each value comes from. Solves the problem of `.et` files only showing overrides. |
| `asset_search` | Search game assets by name across loose files and `.pak` archives |
| `project_browse` | List files in a mod project directory. In a multi-mod workspace (`ENFUSION_PROJECT_PATH` pointing at a directory of addons), browsing the root with no `modName` lists the discovered addon folders instead |
| `project_read` | Read any project file. Accepts `modName` to scope into a specific addon in a multi-mod workspace |
| `project_write` | Write or update project files (supports `dryRun` to preview without writing). Accepts `modName` to scope into a specific addon in a multi-mod workspace |
| `project_patch` | Apply diff-style find-and-replace edits to a project file without rewriting the whole thing — mirrors Claude Code's Edit tool semantics (`oldString` must match exactly once unless `replaceAll` is set; all edits are atomic; supports `dryRun` to preview) |
| `mod_create` | Scaffold a complete addon with directory structure and `.gproj` (supports `dryRun` to preview without writing) |
| `script_create` | Generate Enforce Script (`.c`) files — 7 types: component, gamemode, action, entity, manager, modded, basic. Auto-fetches overridable parent methods from API index when `parentClass` is specified (supports `dryRun` to preview without writing). Automatically surfaces relevant known Enfusion gotchas from `data/pitfalls.json` (e.g. missing `SetEventMask` for frame events, modded-class scope) based on the script's type, description, and methods |
| `prefab_create` | Generate Entity Template (`.et`) prefabs — 7 types: character, vehicle, weapon, spawnpoint, gamemode, interactive, generic (supports `dryRun` to preview without writing) |
| `layout_create` | Generate UI layout (`.layout`) files — 5 types: hud, menu, dialog, list, custom (supports `dryRun` to preview without writing) |
| `config_create` | Generate config files — factions, missions, entity catalogs, editor placeables (supports `dryRun` to preview without writing) |
| `server_config` | Generate dedicated server config for local testing |
| `mod_validate` | Validate project structure, scripts, prefabs, configs, and naming. Accepts `modName` to scope validation to a specific addon in a multi-mod workspace. Each issue may include a machine-executable `fix` (e.g. `{action:'move', from, to}`, `{action:'addDependency', gproj, dependency}`, `{action:'setField', file, field, value}`, `{action:'rename', from, to}`, `{action:'create', path, contentHint}`) when the correct remediation is unambiguous; returned in both the text report (inline `[fix: {...}]` annotations) and `structuredContent.issues[]` for programmatic consumption |
| `mod_build` | Build the addon using the Workbench CLI |
| `mod_publish` | Resolves `addonName` to a concrete `.gproj` (or uses an explicit `gprojPath`) and always targets it via `-gproj`, so it never falls back to whatever addon Workbench's session last had open. Unless `dryRun=true`, runs a real `-packAddon` pack (not irreversible, so it runs without confirmation); additionally uploads via `-publishAddon`, with version updates, only when `confirmPublish=true`. `dryRun=true` previews the command without running anything. A mod's *first-ever* publish (name, category, tags, license, visibility, summary, description) has no CLI equivalent and always requires one manual pass through Workbench > Publish Project — this action only automates packing and subsequent version updates |
| `wb_log` | Read Workbench console/script logs from disk and parse `SCRIPT (E)` compile errors with source context — works even when NET API handlers fail to compile, since it doesn't go through the live connection |

### Live Workbench Tools

Control a running Workbench instance over TCP. Requires the handler scripts installed (see setup above).

| Tool | What it does |
|------|-------------|
| `wb_launch` | Start Workbench if not running, wait for NET API |
| `wb_connect` | Test connection to Workbench |
| `wb_state` | Full state snapshot — mode, world, entity count, selection |
| `wb_game_state` | Inspect the live game world in PLAY mode (the World Editor API is null there, so every other `wb_*` tool fails) — world time, active entity count, filterable/paginated entity list, and connected players with positions. Read-only; requires play mode |
| `wb_screenshot` | Capture the running Workbench window as a PNG so the agent can visually verify its work. OS-level window capture (PowerShell + `PrintWindow`) — no NET API handler or Workbench restart needed, but it captures the whole window (menus/panels included), not an isolated viewport render. Requires Workbench running with a visible (non-minimized) window |
| `wb_play` | Switch to game mode (Play in Editor) |
| `wb_stop` | Return to edit mode |
| `wb_save` | Save the current world |
| `wb_undo_redo` | Undo or redo the last action |
| `wb_open_resource` | Open a resource in its editor |
| `wb_reload` | Reload scripts or plugins without restarting — automatically waits for the console log to grow and surfaces any new compile errors (file:line, message, ±5 lines of source context) in the response |
| `wb_execute_action` | Run any Workbench menu action by path |
| `wb_entity_create` | Create entity from prefab at a position |
| `wb_entity_delete` | Delete entity by name |
| `wb_entity_list` | List and search entities in the world |
| `wb_entity_inspect` | Get entity details — properties, components, children |
| `wb_entity_modify` | Move, rotate, rename, reparent, set/clear/get/list properties, list/add/remove array items |
| `wb_entity_select` | Select, deselect, clear, get current selection |
| `scenario_create` | Place a Scenario Framework objective (Area → LayerTask → Slot + Layer_AI → SlotAI×N, with `aiSpawnCount`/`aiSpawnOffset` for multiple offset AI groups) or a Conflict base (ConflictBase + patrol spawnpoints + faction spawn point) |
| `wb_component` | Add, remove, list entity components — supports lookup by name or index (for unnamed entities) |
| `wb_terrain` | Query terrain height and world bounds |
| `wb_layers` | Create, delete, rename layers, set visibility/active |
| `wb_resources` | Register resources, rebuild database |
| `wb_prefabs` | Create templates, save, GUID lookup |
| `wb_clipboard` | Copy, cut, paste, duplicate entities |
| `wb_script_editor` | Read/write lines in the open script file |
| `wb_localization` | String table CRUD for localization |
| `wb_projects` | List loaded projects, open `.gproj` files |
| `wb_validate` | Material and texture validation |

### Mod Patterns

10 built-in templates for `mod_create`:

`game-mode` `custom-faction` `custom-action` `spawn-system` `custom-component` `modded-behavior` `admin-tool` `custom-vehicle` `weapon-reskin` `hud-widget`

### MCP Resources

| URI | Description |
|-----|-------------|
| `enfusion://class/{className}` | Full class docs with inheritance, methods, ancestors/descendants |
| `enfusion://pattern/{patternName}` | Mod pattern definition with all templates |
| `enfusion://group/{groupName}` | API group with class list |

## Configuration

All optional. Sensible defaults are used when nothing is set.

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `ENFUSION_PROJECT_PATH` | Default mod output directory. Can also point at a multi-mod workspace directory containing several addon folders — see below | `~/Documents/My Games/ArmaReforgerWorkbench/addons` |
| `ENFUSION_DEFAULT_MOD` | Addon folder name (under `ENFUSION_PROJECT_PATH`) to use when a tool call omits `modName`. Also set automatically when `wb_launch` opens a `.gproj` | none |
| `ENFUSION_WORKBENCH_PATH` | Path to Arma Reforger Tools | `C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Tools` |
| `ENFUSION_GAME_PATH` | Path to the Arma Reforger game install (used as CWD when launching Workbench so base-game addons resolve correctly) | Auto-detected from sibling of `ENFUSION_WORKBENCH_PATH` |
| `ENFUSION_WORKBENCH_HOST` | NET API host | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | NET API port | `5775` |

Config can also be loaded from `~/.enfusion-mcp/config.json`. Environment variables take priority.

### Multi-mod workspaces

`ENFUSION_PROJECT_PATH` can point at either a single addon (legacy behavior — the directory itself contains the `.gproj`) or a workspace directory containing several addon folders. In workspace mode:

- Pass `modName` to `project` (browse/read/write), `mod` (`action='validate'`), `game_duplicate`, and `animation_graph` to scope the call to a specific addon folder (filesystem path resolved via `resolveAddonDir`).
- `server_config` also accepts `modName`, but it isn't a directory-scoping parameter there — it's the addon ID string written into the generated `server.json`'s mod list, not a filesystem path lookup.
- `project browse` at the workspace root with no `modName` and no `path` lists the discovered addon folders instead of doing a plain file listing.
- If `modName` is omitted, tools fall back to `ENFUSION_DEFAULT_MOD` (or the raw configured `projectPath` if that isn't set either), so single-mod setups keep working unchanged.
- Addon detection also handles layouts where the `.gproj` lives one level below the addon folder (e.g. `Central-Economy/source/addon.gproj`), not just at the addon root.

## Requirements

- **Node.js 20+**
- **Arma Reforger Tools** (Steam) — needed for `mod_build` and all `wb_*` tools

## Development

```bash
git clone https://github.com/steffenbk/enfusion-mcp-BK.git
cd enfusion-mcp-BK
npm install
npm run scrape   # Build API index from Workbench docs
npm run build
npm test         # 187 tests
```

## License

MIT
