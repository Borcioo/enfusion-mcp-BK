# Faza 0+1: Fundament + bugfixy TODO — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Uruchomić MCP z forka lokalnie z pełną pętlą connect→state→reload na projekcie Central-Economy, potem naprawić oba bugi z TODO.md przez zapis hierarchii scenario bezpośrednio do pliku `.layer`.

**Architecture:** Faza 0 to konfiguracja bez zmian kodu (rejestracja MCP z lokalnego builda, config env, smoke test). Faza 1 dodaje `parseMultiple()` do istniejącego parsera Enfusion-text, nowy moduł `src/formats/layer-writer.ts` budujący blok Area→LayerTask→{Slot, Layer_AI→SlotAI×N} jako drzewo `EnfusionNode`, i przełącza `scenario_create type=objective` z sekwencji API-create-reparent na zapis do pliku + reload świata. Format `.layer` jest ustalany empirycznie: najpierw złota próbka z żywego Workbencha (fixture), potem TDD przeciwko niej.

**Tech Stack:** TypeScript (ESM, Node >= 20), Vitest, MCP SDK; Enforce Script handlery tylko czytane (Faza 1 nie zmienia `.c` poza ewent. `EMCP_WB_GetState` — patrz Task 5).

## Global Constraints

- Repo: `D:\Projekty\ArmaReforger\enfusion-mcp-BK` (fork `Borcioo/enfusion-mcp-BK`), branch bazowy `main`.
- Kod, komentarze, commity: **angielski**. Konwencja commitów: `feat:` / `fix:` / `docs:` / `test:`.
- Każdy task = osobna gałąź `fix/...` lub `feat/...`; PR do `Borcioo/enfusion-mcp-BK:main` (PR-friendly pod upstream).
- Przed każdym commitem: `npm run build && npm test` musi być zielone.
- Checklist repo przy zmianie narzędzia (z `UPGRADE_IDEAS.md`): testy, `description` w `src/tools/*.ts`, prompty `src/prompts/*.ts` jeśli dotyczy, tabela w `README.md`, odhaczenie w `TODO.md`.
- Live testy: Workbench uruchamiany przez `wb_launch` (MCP), projekt Central-Economy (`D:\Projekty\ArmaReforger\Central-Economy\source\addon.gproj`).
- NIE killować procesu Workbencha (dzieli NET API z innymi klientami).

---

## FAZA 0 — Fundament (bez PR, konfiguracja lokalna)

### Task 1: Build forka i testy bazowe

**Files:** brak zmian (weryfikacja stanu zastanego).

- [ ] **Step 1: Zainstaluj zależności i zbuduj**

Run: `cd D:\Projekty\ArmaReforger\enfusion-mcp-BK && npm install && npm run build`
Expected: build bez błędów, katalog `dist/` z `index.js`.

- [ ] **Step 2: Testy bazowe**

Run: `npm test`
Expected: wszystkie testy PASS (34 pliki testowe). Jeśli cokolwiek FAIL na czystym forku — STOP, zgłoś użytkownikowi (fork miał być zielony).

### Task 2: Lokalizacja instalacji Steam i config

**Files:**
- Create: `D:\Projekty\ArmaReforger\enfusion-mcp-BK\enfusion-mcp.config.json` (jest w `.gitignore`? sprawdzić; jeśli nie — NIE commitować, plik lokalny)

- [ ] **Step 1: Znajdź katalogi gry i narzędzi**

Run (Git Bash):
```bash
for lib in "C:/Program Files (x86)/Steam/steamapps/common" "D:/SteamLibrary/steamapps/common" "E:/SteamLibrary/steamapps/common"; do
  ls "$lib" 2>/dev/null | grep -i "arma reforger"
done
```
Expected: linie `Arma Reforger` i `Arma Reforger Tools` (zanotuj pełne ścieżki). Jeśli brak — zapytaj użytkownika o ścieżki bibliotek Steam.

- [ ] **Step 2: Sprawdź exe Workbencha**

Run: `ls "<TOOLS_PATH>/Workbench/ArmaReforgerWorkbenchSteamDiag.exe"`
Expected: plik istnieje. (Klient szuka też w rootcie TOOLS_PATH — oba układy OK.)

- [ ] **Step 3: Napisz config**

Utwórz `enfusion-mcp.config.json` w rootcie forka (wartości ze Step 1):
```json
{
  "workbenchPath": "<TOOLS_PATH>",
  "gamePath": "<GAME_PATH>",
  "projectPath": "D:\\Projekty\\ArmaReforger",
  "defaultMod": "Central-Economy"
}
```
Uwaga: dokładne nazwy kluczy zweryfikuj w `src/config.ts` (czyta env `ENFUSION_WORKBENCH_PATH`, `ENFUSION_PROJECT_PATH`, `ENFUSION_GAME_PATH`, `ENFUSION_DEFAULT_MOD` oraz plik `enfusion-mcp.config.json` / `~/.enfusion-mcp/config.json`). Jeśli schema pliku różni się od powyższego — dostosuj do schemy z `config.ts`, nie odwrotnie.

- [ ] **Step 4: Problem zagnieżdżonego gproj**

`Central-Economy/source/addon.gproj` leży w podkatalogu `source/`, a `findFallbackGproj()` w `src/workbench/client.ts:553-589` skanuje tylko PIERWSZY poziom (`addonsDir/<mod>/*.gproj`). Sprawdź:

Run: `ls "D:\Projekty\ArmaReforger\Central-Economy"/*.gproj 2>/dev/null; ls "D:\Projekty\ArmaReforger\Central-Economy\source"/*.gproj`
Expected: gproj tylko w `source/`. Jeśli tak — `defaultMod` ustaw na `Central-Economy\source` (ścieżka względna działa, bo klient robi `join(addonsDir, preferred)`), przetestuj w Task 3. Jeśli join z backslashem nie zadziała na tym układzie — fallback: `"defaultMod": "Central-Economy/source"`. Zanotuj wynik w tym pliku planu (edytuj checkbox z adnotacją).

### Task 3: Rejestracja MCP i smoke test

**Files:** brak (rejestracja w Claude Code).

- [ ] **Step 1: Usuń ewentualną starą rejestrację z npm**

Run: `claude mcp list 2>/dev/null | grep -i enfusion; claude mcp remove enfusion-mcp --scope user 2>/dev/null; claude mcp remove enfusion-mcp --scope project 2>/dev/null; echo done`
Expected: `done` (brak błędu fatalnego; remove może zgłosić "not found" — OK).

- [ ] **Step 2: Zarejestruj z lokalnego builda, scope project**

Run: `cd D:\Projekty\ArmaReforger && claude mcp add --scope project enfusion-mcp -- node D:\Projekty\ArmaReforger\enfusion-mcp-BK\dist\index.js`
Expected: wpis w `.mcp.json` w `D:\Projekty\ArmaReforger`. Env/config: server czyta config z CWD procesu — jeśli nie podniesie `enfusion-mcp.config.json` z rootu forka, przenieś wartości do bloku `env` w `.mcp.json` (`ENFUSION_WORKBENCH_PATH` itd.).

- [ ] **Step 3: Restart sesji Claude Code i weryfikacja**

Po restarcie: `/mcp` pokazuje `enfusion-mcp` connected. Narzędzia `api_search`, `wb_diagnose` widoczne.

- [ ] **Step 4: Smoke test offline**

Wywołaj (przez MCP): `api_search` query=`SCR_BaseGameMode`.
Expected: wynik z klasą, rodzicami, metodami — indeks działa.

- [ ] **Step 5: Smoke test live**

Kolejno przez MCP:
1. `wb_diagnose` → raport; oczekiwane `netApi: refused` (WB nie działa) + poprawne ścieżki exe/projektu.
2. `wb_launch` → Workbench startuje z Central-Economy (handlery wstrzyknięte do moda, poll do 90 s).
3. `wb_state` → `mode: edit`, statystyki sceny.
4. `wb_reload` → skrypty przeładowane bez błędu.
Expected: wszystkie 4 OK. To jest kryterium wyjścia Fazy 0. Problemy typowe: NET API wyłączone w WB (File > Options > General > Net API), zły `defaultMod` (Task 2 Step 4).

- [ ] **Step 6: Zanotuj wynik**

Dopisz do tego pliku sekcję `## Wynik Fazy 0` z: ścieżki Steam, użyty `defaultMod`, czy config z pliku czy z env, czas launchu. Commit TYLKO planu (nie configu):
```bash
git add docs/superpowers/plans/2026-07-03-faza-0-1-fundament-i-bugfixy.md
git commit -m "docs: record phase 0 environment results"
```

---

## FAZA 1 — Bugfixy TODO.md (zapis hierarchii do .layer)

Kontekst bugów (z `TODO.md`):
- **BUG 1:** `scenario_create type=objective` składa hierarchię przez `EMCP_WB_CreateEntity` + reparent (`wb-scenario.ts:236-257`), ale Workbench przy zapisie świata przestawia zagnieżdżenie — SlotKill ląduje w Layer_AI. `SCR_ScenarioFrameworkLayerTask.GetSlotTask()` szuka slotu tylko w BEZPOŚREDNICH dzieciach LayerTask → `missing m_SlotTask`.
- **BUG 2:** enum `m_eActivationType ON_TRIGGER_ACTIVATION` nie ustawia się przez `SetVariableValue` (`setEntityProp` w `wb-scenario.ts:51-71` zgłasza warning).
- **Wspólny fix:** wygenerować cały blok hierarchii i zapisać go bezpośrednio do pliku `.layer` (enum jako tekst w pliku), zamiast składać przez API.

Wymagana poprawna hierarchia:
```
Area
└── LayerTask
    ├── Slot (SlotKill / SlotClearArea / SlotDestroy)  ← bezpośrednie dziecko LayerTask
    └── Layer_AI
        └── SlotAI (×N)
```

### Task 4: Złota próbka formatu .layer (fixture)

**Files:**
- Create: `tests/fixtures/objective-hierarchy.layer` (poprawna hierarchia — cel)
- Create: `tests/fixtures/objective-hierarchy-broken.layer` (to, co WB zapisuje po obecnym flow — dokumentacja buga)

**Interfaces:**
- Produces: dwa pliki fixture używane przez testy Tasków 5-6. Format wzięty z realnego zapisu WB, nie zgadywany.

- [ ] **Step 1: Wygeneruj hierarchię obecnym (zbugowanym) narzędziem**

Na żywym WB (Faza 0 działa): otwórz world Central-Economy (albo pusty world testowy — utwórz w WB `worlds/EMCPTest/EMCPTest.ent`), wywołaj przez MCP `scenario_create` z:
`type=objective, taskType=kill, taskName=Fixture_Test, description=fixture, targetPrefab={GUID z asset_search dla Character_USSR_Rifleman}, aiGroupPrefab={GUID dla Group_USSR_LightFireTeam}, position="100 0 100"`.
Potem `wb_save`.
Expected: encje utworzone, world zapisany; w odpowiedzi narzędzia prawdopodobnie property warnings dla `m_eActivationType` (BUG 2 — potwierdzenie).

- [ ] **Step 2: Zgraj zapisany .layer jako broken fixture**

Run: `find "D:\Projekty\ArmaReforger\Central-Economy" -name "*.layer" -newer "D:\Projekty\ArmaReforger\enfusion-mcp-BK\package.json" 2>/dev/null`
(albo ścieżka world-a z kroku 1). Skopiuj fragment z encjami `Fixture_Test_*` do `tests/fixtures/objective-hierarchy-broken.layer`. Zweryfikuj w treści: `Fixture_Test_Slot` zagnieżdżony w `Fixture_Test_Layer_AI` (BUG 1 widoczny) — jeśli NIE (WB zapisał poprawnie), STOP: bug nie reprodukuje się, wróć do TODO.md i zbadaj warunki (wersja WB?); nie kontynuuj fixa bez reprodukcji.

- [ ] **Step 3: Ręcznie napraw hierarchię i zgraj jako poprawny fixture**

W pliku `.layer` przenieś blok `Fixture_Test_Slot` tak, by był bezpośrednim dzieckiem `Fixture_Test_LayerTask` (wg TODO.md ręczny fix działał). Dopisz w bloku slotu property `m_eActivationType ON_TRIGGER_ACTIVATION` (składnia enum = bare identifier — zweryfikuj po innych enumach w pliku). Wczytaj world w WB, uruchom play (`wb_play`), sprawdź brak błędu `missing m_SlotTask` w konsoli WB. Zapisz naprawiony fragment do `tests/fixtures/objective-hierarchy.layer`.

- [ ] **Step 4: Commit fixtures**

```bash
git checkout -b fix/scenario-layer-write
git add tests/fixtures/objective-hierarchy.layer tests/fixtures/objective-hierarchy-broken.layer
git commit -m "test: add golden .layer fixtures for scenario hierarchy bug"
```

### Task 5: `parseMultiple()` w enfusion-text + layer-writer

**Files:**
- Modify: `src/formats/enfusion-text.ts` (dodaj `parseMultiple`)
- Create: `src/formats/layer-writer.ts`
- Test: `tests/formats/layer-writer.test.ts`, rozszerz `tests/formats/enfusion-text.test.ts` (jeśli plik nazywa się inaczej — znajdź test parsera: `ls tests | grep -i enfusion`)

**Interfaces:**
- Consumes: `parse`, `serialize`, `createNode`, `EnfusionNode` z `enfusion-text.ts`; fixtures z Task 4.
- Produces:
  - `parseMultiple(input: string): EnfusionNode[]` — parsuje dokument z wieloma węzłami top-level (`.layer`),
  - `buildObjectiveNodes(opts: ObjectiveOpts): EnfusionNode` — drzewo Area→LayerTask→{Slot, Layer_AI→SlotAI×N},
  - `appendEntitiesToLayer(layerText: string, node: EnfusionNode): string` — dokleja zserializowany blok do treści `.layer`,
  - typ `ObjectiveOpts` (patrz Step 3).

- [ ] **Step 1: Failing test — parseMultiple**

W teście parsera dodaj:
```typescript
import { parseMultiple, serialize } from "../../src/formats/enfusion-text.js";

describe("parseMultiple", () => {
  it("parses a document with multiple top-level nodes", () => {
    const input = `GenericEntity "{AAA}" {\n coords 1 2 3\n}\nGenericEntity "{BBB}" {\n coords 4 5 6\n}`;
    const nodes = parseMultiple(input);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]!.id).toBe("{AAA}");
    expect(nodes[1]!.id).toBe("{BBB}");
  });

  it("round-trips the broken fixture without losing entities", () => {
    const text = readFileSync("tests/fixtures/objective-hierarchy-broken.layer", "utf-8");
    const nodes = parseMultiple(text);
    expect(nodes.length).toBeGreaterThan(0);
    const reserialized = nodes.map(n => serialize(n)).join("\n");
    expect(parseMultiple(reserialized)).toHaveLength(nodes.length);
  });
});
```

- [ ] **Step 2: Run — verify FAIL**

Run: `npx vitest run tests/formats -t parseMultiple`
Expected: FAIL — `parseMultiple` is not exported.

- [ ] **Step 3: Implementacja parseMultiple**

W `enfusion-text.ts`, po `parse()`:
```typescript
/**
 * Parse a document containing multiple top-level nodes (e.g. .layer files,
 * where each world entity is its own root-level block).
 */
export function parseMultiple(input: string): EnfusionNode[] {
  const tokens = tokenize(input);
  if (tokens.length === 0) return [];
  const parser = new Parser(tokens);
  const nodes: EnfusionNode[] = [];
  while (parser.hasMore()) {
    nodes.push(parser.parseDocument());
  }
  return nodes;
}
```
Dodaj w klasie `Parser` metodę:
```typescript
hasMore(): boolean {
  return this.pos < this.tokens.length;
}
```

- [ ] **Step 4: Run — verify PASS**

Run: `npx vitest run tests/formats -t parseMultiple`
Expected: PASS oba testy. Jeśli round-trip fixture FAIL — realny format `.layer` ma konstrukcje, których parser nie zna; napraw parser (to test odkrywczy — dlatego fixture przed kodem).

- [ ] **Step 5: Failing testy — layer-writer**

`tests/formats/layer-writer.test.ts`:
```typescript
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildObjectiveNodes, appendEntitiesToLayer, type ObjectiveOpts } from "../../src/formats/layer-writer.js";
import { parseMultiple } from "../../src/formats/enfusion-text.js";

const OPTS: ObjectiveOpts = {
  taskType: "kill",
  taskName: "Fixture_Test",
  description: "fixture",
  position: "100 0 100",
  triggerRadius: 100,
  targetPrefab: "{TGT}Prefabs/Characters/X.et",
  aiGroupPrefab: "{GRP}Prefabs/Groups/Y.et",
  aiSpawnCount: 1,
};

describe("buildObjectiveNodes", () => {
  it("puts the Slot as a DIRECT child of LayerTask, not inside Layer_AI", () => {
    const area = buildObjectiveNodes(OPTS);
    const layerTask = area.children.find(c => c.properties.some(p => p.key === "Name" && p.value === "Fixture_Test_LayerTask"))
      ?? area.children[0]!;
    const childNames = layerTask.children.map(c => String(c.properties.find(p => p.key === "Name")?.value ?? ""));
    expect(childNames).toContain("Fixture_Test_Slot");
    expect(childNames).toContain("Fixture_Test_Layer_AI");
    const layerAI = layerTask.children.find(c => c.properties.some(p => p.value === "Fixture_Test_Layer_AI"))!;
    expect(layerAI.children.map(c => String(c.properties.find(p => p.key === "Name")?.value ?? "")))
      .toEqual(["Fixture_Test_SlotAI_1"]);
  });

  it("writes m_eActivationType as a bare enum identifier", () => {
    const area = buildObjectiveNodes(OPTS);
    const serialized = appendEntitiesToLayer("", area);
    expect(serialized).toMatch(/m_eActivationType ON_TRIGGER_ACTIVATION/);
    expect(serialized).not.toMatch(/m_eActivationType "ON_TRIGGER_ACTIVATION"/);
  });

  it("spawns N SlotAI when aiSpawnCount > 1", () => {
    const area = buildObjectiveNodes({ ...OPTS, aiSpawnCount: 3 });
    const serialized = appendEntitiesToLayer("", area);
    expect(serialized.match(/Fixture_Test_SlotAI_/g)).toHaveLength(3);
  });

  it("matches the structure of the golden fixture", () => {
    const golden = parseMultiple(readFileSync("tests/fixtures/objective-hierarchy.layer", "utf-8"));
    const built = parseMultiple(appendEntitiesToLayer("", buildObjectiveNodes(OPTS)));
    // Same nesting depth signature: Area > LayerTask > [Slot, Layer_AI > SlotAI]
    const shape = (n: import("../../src/formats/enfusion-text.js").EnfusionNode): string =>
      `${n.type}(${n.children.map(shape).join(",")})`;
    expect(built.map(shape).join(";")).toBe(golden.map(shape).join(";"));
  });
});

describe("appendEntitiesToLayer", () => {
  it("appends after existing entities preserving them", () => {
    const existing = readFileSync("tests/fixtures/objective-hierarchy-broken.layer", "utf-8");
    const before = parseMultiple(existing).length;
    const out = appendEntitiesToLayer(existing, buildObjectiveNodes({ ...OPTS, taskName: "Second" }));
    expect(parseMultiple(out).length).toBe(before + 1);
  });
});
```
UWAGA: asercje o `Name`/typach węzłów dopasuj do REALNEJ struktury złotego fixture'a (Step 3 Taska 4) — powyższe to szkielet; property z nazwą encji w `.layer` może nazywać się inaczej (sprawdź w fixture; w plikach Enfusion bywa to `Name` w bloku encji albo id węzła). Test „matches the golden fixture" jest źródłem prawdy — pozostałe dopasuj.

- [ ] **Step 6: Run — verify FAIL**

Run: `npx vitest run tests/formats/layer-writer.test.ts`
Expected: FAIL — moduł nie istnieje.

- [ ] **Step 7: Implementacja layer-writer**

`src/formats/layer-writer.ts`:
```typescript
/**
 * Builds ScenarioFramework objective hierarchies as EnfusionNode trees and
 * writes them directly into .layer file text.
 *
 * Why file-level writes: composing the hierarchy via EMCP_WB_CreateEntity +
 * reparent calls does not persist correct nesting (Workbench rewrites child
 * order on save — see TODO.md), and enum properties cannot be set through
 * SetVariableValue. Writing the .layer block directly solves both.
 */
import { createNode, serialize, type EnfusionNode } from "./enfusion-text.js";

const SF = "Prefabs/Systems/ScenarioFramework/Components";

const PREFABS: Record<string, { layerTask: string; slot: string; slotComp: string; layerComp: string }> = {
  kill: {
    layerTask: `{2008B4EE6C4D528E}${SF}/LayerTaskKill.et`,
    slot: `{C70DC6CBD1AAEC9A}${SF}/SlotKill.et`,
    slotComp: "SCR_ScenarioFrameworkSlotKill",
    layerComp: "SCR_ScenarioFrameworkLayerTaskKill",
  },
  clearArea: {
    layerTask: `{CDC0845AD90BA073}${SF}/LayerTaskClearArea.et`,
    slot: `{E53456990A756229}${SF}/SlotClearArea.et`,
    slotComp: "SCR_ScenarioFrameworkSlotClearArea",
    layerComp: "SCR_ScenarioFrameworkLayerTaskClearArea",
  },
  destroy: {
    layerTask: `{5EDF39860639027D}${SF}/LayerTaskDestroy.et`,
    slot: `{7586595959BA2D99}${SF}/SlotDestroy.et`,
    slotComp: "SCR_ScenarioFrameworkSlotDestroy",
    layerComp: "SCR_ScenarioFrameworkLayerTaskDestroy",
  },
};

const AREA_PREFAB = `{C72F956E4AC6A6E7}${SF}/Area.et`;
const LAYER_PREFAB = `{5F9FFF4BF027B3A3}${SF}/Layer.et`;
const SLOT_AI_PREFAB = `{8D43830F02C3F114}${SF}/SlotAI.et`;
const WAIT_WAYPOINT = "{531EC45063C1F57B}Prefabs/AI/Waypoints/AIWaypoint_Wait.et";

export interface ObjectiveOpts {
  taskType: "kill" | "clearArea" | "destroy";
  taskName: string;
  description: string;
  position: string;          // "x y z"
  triggerRadius: number;
  targetPrefab: string;
  aiGroupPrefab: string;
  aiSpawnCount: number;      // >= 1
  aiSpawnOffset?: string;    // "x y z" relative to area centre, default "0 0 0"
  faction?: string;
}

/** Build the full Area > LayerTask > {Slot, Layer_AI > SlotAI xN} tree. */
export function buildObjectiveNodes(opts: ObjectiveOpts): EnfusionNode {
  // NOTE: exact node shape (entity type names, Name property vs node id,
  // component sub-blocks) MUST mirror tests/fixtures/objective-hierarchy.layer.
  // The skeleton below encodes the logical structure; align details with the
  // fixture during implementation (the golden-fixture test enforces this).
  const p = PREFABS[opts.taskType]!;

  const slot = entityNode(p.slot, `${opts.taskName}_Slot`, [
    componentNode(p.slotComp, [
      ["m_sObjectToSpawn", opts.targetPrefab],
      ["m_sWPToSpawn", WAIT_WAYPOINT],
      ["m_eActivationType", "ON_TRIGGER_ACTIVATION"],
    ]),
  ]);

  const slotAIs = Array.from({ length: Math.max(1, opts.aiSpawnCount) }, (_, i) =>
    entityNode(SLOT_AI_PREFAB, `${opts.taskName}_SlotAI_${i + 1}`, [
      componentNode("SCR_ScenarioFrameworkSlotAI", [
        ["m_sObjectToSpawn", opts.aiGroupPrefab],
        ["m_eActivationType", "ON_TRIGGER_ACTIVATION"],
      ]),
    ], opts.aiSpawnOffset)
  );

  const layerAI = entityNode(LAYER_PREFAB, `${opts.taskName}_Layer_AI`, [], undefined, slotAIs);

  const layerTaskProps: Array<[string, string]> = [
    ["m_sTaskTitle", opts.taskName],
    ["m_sTaskDescription", opts.description],
  ];
  if (opts.faction) layerTaskProps.push(["m_sFactionKey", opts.faction]);
  const layerTask = entityNode(p.layerTask, `${opts.taskName}_LayerTask`,
    [componentNode(p.layerComp, layerTaskProps)], undefined, [slot, layerAI]);

  return entityNode(AREA_PREFAB, `${opts.taskName}_Area`,
    [componentNode("SCR_ScenarioFrameworkArea", [["m_fAreaRadius", String(opts.triggerRadius)]])],
    opts.position, [layerTask]);
}

/** Append a serialized entity block to .layer text (idempotent trailing newline). */
export function appendEntitiesToLayer(layerText: string, node: EnfusionNode): string {
  const block = serialize(node);
  if (layerText.trim().length === 0) return block + "\n";
  return layerText.replace(/\s*$/, "\n") + block + "\n";
}

// -- helpers (align exact shapes with the golden fixture) --

function entityNode(
  prefab: string, name: string, components: EnfusionNode[],
  coords?: string, children: EnfusionNode[] = [],
): EnfusionNode {
  const node = createNode("SCR_ScenarioFrameworkEntityStub", { inheritance: prefab, children });
  // Placeholder type — replace with the real per-entity type from the fixture.
  node.properties.push({ key: "Name", value: name });
  if (coords) node.properties.push({ key: "coords", value: coords });
  for (const c of components) node.children.unshift(c);
  return node;
}

function componentNode(className: string, props: Array<[string, string]>): EnfusionNode {
  const node = createNode(className);
  for (const [key, value] of props) node.properties.push({ key, value });
  return node;
}
```
KRYTYCZNE: `entityNode` z placeholderem typu jest do ZASTĄPIENIA rzeczywistą strukturą z fixture'a (test golden-fixture to wymusi). Prawdopodobne odkrycia z fixture'a: nazwa encji jako `id` węzła zamiast property `Name`; komponenty w bloku `components { ... }`; coords jako trzy liczby bare. Dopasuj kod, nie fixture.

- [ ] **Step 8: Run — verify PASS**

Run: `npx vitest run tests/formats`
Expected: PASS wszystkie. Potem pełny: `npm run build && npm test` — PASS.

- [ ] **Step 9: Commit**

```bash
git add src/formats/enfusion-text.ts src/formats/layer-writer.ts tests/formats/layer-writer.test.ts tests/formats/*.test.ts
git commit -m "feat: add parseMultiple and layer-writer for direct .layer hierarchy writes"
```

### Task 6: Przełączenie scenario_create na layer-writer

**Files:**
- Modify: `src/tools/wb-scenario.ts` (gałąź `type === "objective"`, linie 199-337)
- Modify: `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_GetState.c` — TYLKO jeśli nie zwraca ścieżki aktywnego world-a (Step 1)
- Test: `tests/tools/wb-scenario.test.ts` (nowy — dotąd brak testu tego narzędzia)

**Interfaces:**
- Consumes: `buildObjectiveNodes`, `appendEntitiesToLayer`, `ObjectiveOpts` z Task 5; `client.call("EMCP_WB_GetState")`.
- Produces: `scenario_create type=objective` z nowymi parametrami `aiSpawnCount` (default 1), `aiSpawnOffset` (optional); pisze do `.layer` i przeładowuje world.

- [ ] **Step 1: Ustal, skąd wziąć ścieżkę aktywnego world-a**

Przeczytaj `mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_GetState.c`. Jeśli odpowiedź zawiera ścieżkę pliku world/subscene → użyj jej. Jeśli nie → dodaj pole (np. `worldFile`) do struktu odpowiedzi: WorldEditorAPI ma metody na aktualny world resource (szukaj `GetWorldPath` / `GetLoadedWorldPath` w `api_search`). Zmiana `.c` = handler przekompiluje się przy `wb_reload`. Fallback jeśli API nie daje ścieżki: parametr `layerFile` wymagany w narzędziu (ścieżka podana przez wołającego).

- [ ] **Step 2: Failing test — logika narzędzia (unit, mock klienta)**

`tests/tools/wb-scenario.test.ts` — testuj wyekstrahowaną funkcję (Step 3 wydziela `createObjectiveViaLayerFile`), mockując fs i klienta:
```typescript
import { describe, it, expect, vi } from "vitest";
import { createObjectiveViaLayerFile } from "../../src/tools/wb-scenario.js";

describe("createObjectiveViaLayerFile", () => {
  it("appends hierarchy to the layer file and requests world reload", async () => {
    const calls: string[] = [];
    const client = { call: vi.fn(async (fn: string) => { calls.push(fn); return { status: "ok", worldFile: "worlds/T/T.ent" }; }) };
    const files = new Map<string, string>([["worlds/T/default.layer", ""]]);
    const io = {
      read: (p: string) => files.get(p) ?? "",
      write: (p: string, c: string) => void files.set(p, c),
      resolveLayerPath: (worldFile: string) => "worlds/T/default.layer",
    };
    const result = await createObjectiveViaLayerFile(client as never, io, {
      taskType: "kill", taskName: "T1", description: "d", position: "1 0 1",
      triggerRadius: 50, targetPrefab: "{A}x.et", aiGroupPrefab: "{B}y.et", aiSpawnCount: 2,
    });
    expect(files.get("worlds/T/default.layer")).toMatch(/T1_LayerTask/);
    expect(files.get("worlds/T/default.layer")).toMatch(/m_eActivationType ON_TRIGGER_ACTIVATION/);
    expect(result.entities).toContain("T1_SlotAI_2");
    expect(calls).toContain("EMCP_WB_GetState");        // world lookup
    expect(calls.some(c => c === "EMCP_WB_EditorControl" || c === "EMCP_WB_Resources")).toBe(true); // reload request
  });
});
```
(Dokładny handler reloadu wybierz w Step 3 — asercję dopasuj.)

- [ ] **Step 3: Implementacja**

W `wb-scenario.ts`:
1. Wydziel eksportowaną funkcję `createObjectiveViaLayerFile(client, io, opts: ObjectiveOpts): Promise<{ entities: string[]; layerFile: string }>` — logika: `EMCP_WB_GetState` → ścieżka world → `io.resolveLayerPath` → `io.read` → `appendEntitiesToLayer(text, buildObjectiveNodes(opts))` → `io.write` → wywołanie reloadu world-a w WB. Reload: preferuj istniejący handler (`EMCP_WB_EditorControl` open-resource na world, albo `EMCP_WB_Resources` rebuild) — sprawdź który działa na żywo; wybór zapisz w komentarzu.
2. Gałąź `type === "objective"` woła nową funkcję zamiast sekwencji create/reparent/setProperty (usuwa użycie `setEntityProp` dla slotów; `PREFABS`/stałe przenieś do `layer-writer.ts`, w `wb-scenario.ts` zostaw import).
3. Nowe parametry schematu: `aiSpawnCount: z.number().min(1).max(12).default(1)`, `aiSpawnOffset: z.string().optional()`.
4. `io` w produkcji: `node:fs` + rozwiązywanie ścieżki `.layer` względem `config.projectPath` — subscene default (`<world>_Layers/default.layer`; zweryfikuj wzorzec na realnym worldzie z Task 4).

- [ ] **Step 4: Run — verify PASS**

Run: `npx vitest run tests/tools/wb-scenario.test.ts` → PASS; potem `npm run build && npm test` → PASS.

- [ ] **Step 5: Live test end-to-end**

Na żywym WB: `scenario_create type=objective taskName=Live_E2E ... aiSpawnCount=2` → potem:
1. Odczyt pliku `.layer` — hierarchia poprawna (Slot bezpośrednio pod LayerTask), enum obecny, 2×SlotAI.
2. World przeładowany w WB bez błędów.
3. `wb_play` → w konsoli WB BRAK `could not init task due to missing m_SlotTask`.
Expected: wszystkie 3. To zamyka oba bugi.

- [ ] **Step 6: Dokumentacja i odhaczenie**

- `TODO.md`: oba bugi + FEAT layer-write + FEAT aiSpawnCount/offset → strikethrough z „✅ Done (PR #N)".
- `README.md`: opis `scenario_create` zaktualizowany (nowe parametry, mechanizm zapisu).
- `description` narzędzia w `wb-scenario.ts` zaktualizowany.

- [ ] **Step 7: Commit + PR**

```bash
git add -A
git commit -m "fix: write scenario objective hierarchy directly to .layer file

Fixes SlotKill nesting (GetSlotTask requires the slot as a direct
LayerTask child) and enum property assignment (m_eActivationType),
both broken via the WorldEditorAPI create/reparent path. Adds
aiSpawnCount and aiSpawnOffset parameters."
git push -u origin fix/scenario-layer-write
gh pr create --repo Borcioo/enfusion-mcp-BK --title "fix: scenario objective hierarchy via direct .layer writes" --fill
```

---

## Kryteria zamknięcia planu

- Faza 0: pętla `wb_diagnose→wb_launch→wb_state→wb_reload` działa na Central-Economy; wyniki środowiska zanotowane w tym pliku.
- Faza 1: PR `fix/scenario-layer-write` zmergowany; live E2E bez `missing m_SlotTask`; TODO.md odhaczone.
- Następny krok po zamknięciu: plan Fazy 2 („Oczy": wb_log, wb_game_state, wb_screenshot) — osobny dokument, pisany z wiedzą o realnym formacie `.layer` i zachowaniu NET API zebraną tutaj.

---

## Wynik wykonania (2026-07-03)

**Faza 0:** zamknięta. Steam: `E:\Steam\steamapps\common\{Arma Reforger, Arma Reforger Tools, Arma Reforger Server}`. Config przez `enfusion-mcp.config.json` w rootcie forka (gitignored), `defaultMod: "Central-Economy/source"` (zagnieżdżony gproj działa przez join). MCP scope project w `D:\Projekty\ArmaReforger\.mcp.json`.

**Odkrycia po drodze:**
1. Baseline testów miał 3 upstream failures (test rot + ścieżki autora) → PR #1.
2. Central-Economy nie kompilował się na engine 1.7.0.54: rename `BaseSerializationSaveContext`→`SaveContext`, `BaseSerializationLoadContext`→`LoadContext` → PR #1 w Borcioo/Central-Economy (kandydat do upstreamu CashewSan).
3. **Bugi z TODO.md nie reprodukują się** na 1.7 + kompilującym się Game module. Root cause historycznych obserwacji: moduł Game się nie kompilował → klasy komponentów niedostępne dla SetVariableValue. Taski 5-6 (layer-writer) anulowane za zgodą użytkownika; zamiast tego FEAT-y aiSpawnCount/aiSpawnOffset przez istniejącą ścieżkę API → PR #2.
4. Pak-reader MCP pada na `scripts/Game/generated/Plugins/Persistence/System/Serializers/ScriptedComponentSerializer.c` („invalid block type") → do backlogu Fazy 2+.
5. Indeks API pokazuje sygnatury sprzed 1.7 (stale) → potwierdza priorytet odświeżenia w Fazie 5.
6. Największy praktyczny ból sesji: brak wglądu w konsolę WB (4× ręczne wklejanie) → wb_log priorytetem Fazy 2. Log dir: `C:\Users\macie\OneDrive\Dokumenty\My Games\ArmaReforgerWorkbench\logs\logs_<timestamp>\`.
