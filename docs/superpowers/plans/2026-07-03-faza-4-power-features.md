# Faza 4: Power Features (M-tier) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 10 pozycji M z UPGRADE_IDEAS (+ nowa `mod` publish), w kolejności wg wartości dla pracy nad Central Economy. Wszystkie offline/unit-testowalne poza `publish` (Workbench CLI).

**Status weryfikacji (2026-07-03):** sweep potwierdził — wszystkie niezrobione; #23 częściowe (`modName` w 5 narzędziach: animation-graph, game-duplicate, server-config +2; rdzeń `mod`/`project` bez `modName`).

## Global Constraints

- Repo: `enfusion-mcp-BK`, branch bazowy `main` (3f88b5f, po Fazie 3, 513 pass/1 skip).
- Angielski w kodzie/commitach; `feat:`/`fix:`/`test:`/`docs:`. Task = gałąź + PR do `Borcioo/enfusion-mcp-BK:main`. Przed commitem `npm run build && npm test` zielone.
- Checklist repo: testy, `description`, README, `UPGRADE_IDEAS.md` odhaczenie, rejestracja w `src/server.ts` dla nowych narzędzi.
- KAŻDY task zaczyna od przeczytania obecnego stanu docelowych plików (audyt UPGRADE_IDEAS jest starszy niż kod — część rzeczy bywa już zrobiona; jeśli tak, task = domknięcie testów + doc).
- Kolejność sekwencyjna 1→10; każdy task samodzielny.

---

### Task 1: #24 — Diff-based patching (`project_patch`)

**Files:** Create `src/tools/project-patch.ts`, `tests/tools/project-patch.test.ts`; Modify `src/server.ts`, README.
**Cel:** narzędzie edycji plików bez przepisywania całości — parametry `path`, `edits: [{oldString, newString, replaceAll?}]`. Semantyka jak Edit w Claude Code: `oldString` musi wystąpić dokładnie raz (chyba że `replaceAll`), inaczej błąd bez zapisu. Wspiera `dryRun` (spójnie z Fazą 3). Ścieżki względem `config.projectPath`.
**Testy:** pojedynczy edit; wiele editów sekwencyjnie; oldString nieznaleziony → błąd, plik nietknięty; oldString wieloznaczny bez replaceAll → błąd; replaceAll; dryRun nie zapisuje. Reuse `safe-path` util jeśli jest.
**Acceptance:** iteracja na skrypcie CE zmienia 3 linie bez re-emitu całego pliku.

### Task 2: #13 — `script_check` (walidator sygnatur metod)

**Files:** Create `src/tools/script-check.ts`, `tests/tools/script-check.test.ts`; Modify `src/server.ts`, README.
**Cel:** wejście `className` + `method` (nazwa lub pełna sygnatura); sprawdza w indeksie API czy istnieje. Jeśli tak — zwraca poprawną sygnaturę; jeśli nie — fuzzy match (reuse `src/utils/fuzzy.ts` + `SearchEngine`) i propozycje „did you mean". Uwzględnia metody dziedziczone (SearchEngine ma `getInheritedMembers`).
**Testy:** znana metoda → potwierdzenie + sygnatura; literówka → sugestia najbliższej; metoda rodzica → znaleziona przez inheritance; nieistniejąca → jasny brak. Mock/實 SearchEngine na małym indeksie testowym jeśli jest fixture; inaczej test na realnym indeksie z guardem.
**Acceptance:** `script_check SCR_BaseGameMode GetPlayerManager` → wskazuje że jest na ChimeraGame (dokładnie klasa błędów z Fazy 2).

### Task 3: #23 — Multi-mod workspace (dokończenie)

**Files:** Modify `src/config.ts`, `src/tools/mod.ts`, `src/tools/project.ts` (+ inne tool'e operujące na `config.projectPath`); Test odpowiednie.
**Cel:** `ENFUSION_PROJECT_PATH` może wskazywać katalog z wieloma addonami; narzędzia mutujące/browse przyjmują opcjonalny `modName` wybierający addon; `project browse` bez `modName` listuje addony. Zachowaj zgodność wsteczną (brak `modName` → obecne zachowanie / `defaultMod`). Uwzględnij layout `Central-Economy/source` (gproj w podkatalogu).
**Testy:** browse bez modName listuje addony; z modName wchodzi w addon; mutacja z modName trafia w właściwy addon; brak modName + defaultMod = stare zachowanie.
**Acceptance:** równoległa praca na Central-Economy i drugim addonie bez zmiany configu.

### Task 4: NOWE — `mod` action=publish (pack + Workshop)

**Files:** Modify `src/tools/mod.ts` (nowa akcja), README; ewent. `src/workbench/` helper CLI.
**Cel:** akcja `publish` pakująca addon i publikująca na Workshop przez Workbench CLI (`ArmaReforgerWorkbenchSteamDiag.exe -wbModule=ResourceManager -builddata ...` / publish — dokładne parametry zbadać przez BI wiki + `--help` exe podczas implementacji). Dziś `workshop_info` tylko czyta `.gproj`. RESEARCH-first: jeśli CLI nie wspiera publish headless, zaimplementuj sam pack/builddata i udokumentuj publish jako manualny krok.
**Testy:** konstrukcja polecenia CLI (argv, escaping) unit-testowana; sam pack live jeśli wykonalny bez interakcji.
**Acceptance:** zbudowany `.pak` z addonu przez narzędzie; publish albo działa headless, albo udokumentowany powód rezygnacji.

**Status: complete** (branch `feat/mod-publish`). RESEARCH (BI wiki, `Arma_Reforger:Startup_Parameters#Workbench` + `Arma_Reforger:Mod_Publishing_Process`, via `wiki_search`/`wiki_read`): real CLI flags exist — `-wbModule=ResourceManager -packAddon [-packAddonDir <dir>] -publishAddon [-publishAddonDir <dir>] [-publishAddonVersion <v>] [-publishAddonChangeNote <note>] [-publishAddonChangeNoteFile <path>] [-publishAddonPreviewImage <path>] [-publishAddonScreenshots <dir>]`. HONEST DEGRADE: headless works for *packing* and for *updating* an already-published mod's version/changenote/images — but there are NO CLI flags for Project Name/Category/Tags/License/Visibility/Summary/Description, and the wiki explicitly documents `-publishAddon` as "for publishing addon updates, not the initial publish". So a mod's first-ever publish always needs one manual pass through Workbench > Publish Project GUI; `mod` `action=publish` automates packing + subsequent version updates and documents this limitation in its own response text. Implementation: pure `buildPublishArgs()` in `src/tools/mod.ts` (exported, unit-tested — 12 tests in `tests/tools/mod-publish.test.ts` covering argv construction and handler-level gating), reused `findWorkbenchExe`/`runBuild`/`WORKBENCH_DIAG_EXE` from the existing `build` action. Safety: real Workshop upload only runs when the caller explicitly passes `confirmPublish=true`; default and `dryRun=true` both return the constructed command as a preview without spawning the exe — no real publish was ever executed during implementation.

### Task 5: #18 — Common Pitfalls injection

**Files:** Create `data/pitfalls.json`, Modify `src/tools/script-create.ts` i/lub `src/prompts/create-mod.ts`.
**Cel:** strukturalna lista gotchy Enfusion (np. „modded class jest globalna", „EntityEvent.FRAME wymaga SetEventMask", „ref dla typów referencyjnych", „WorkbenchGame handlery nie hot-reloadują — z tej sesji", „GetPlayerManager na ChimeraGame nie Game — z tej sesji"). Dobierane wg kontekstu tworzenia (typ script_create, słowa kluczowe). Zasil realnymi gotchami zebranymi w Fazach 0-3.
**Testy:** matcher zwraca właściwe pitfalle dla danego kontekstu; JSON waliduje się schemą.

### Task 6: #17 — Example snippets w patterns

**Files:** Modify `data/patterns/*.json` (pole `codeExamples`), `src/patterns/loader.ts` (typ), `src/prompts/create-mod.ts` (wstrzyknięcie).
**Cel:** 3-15-liniowe działające snippety Enforce per pattern dla typowych operacji. Wymaga wiedzy domenowej — snippety muszą być poprawne (weryfikuj metody przez `api_search`/`script_check` z Task 2).
**Testy:** loader parsuje `codeExamples`; każdy pattern z examples ma niepuste, dobrze uformowane wpisy.

### Task 7: #19 — Fix suggestions w mod validate

**Files:** Modify `src/tools/mod.ts` (gałąź validate — `checkStructure`/`checkScripts`/`checkGproj`/`checkReferences`/`checkNaming`), Test.
**Cel:** każde `ValidationIssue` dostaje maszynowo-wykonywalny `fix` (np. `{action:"move", from, to}`), żeby dało się je zastosować automatycznie zamiast parsować tekst.
**Testy:** dla każdego typu issue zwracany jest strukturalny fix o poprawnych polach.

### Task 8: #20 — Used-by backlinks

**Files:** Modify `src/index/search-engine.ts` (reverse index budowany w `load()`), `src/tools/api-search.ts` (pole `usedBy`), ewent. resource klasy.
**Cel:** reverse-lookup: dla klasy znajdź klasy, które ją referencują (parent, typ parametru/zwrotu/property). Wystaw jako `usedBy` w wynikach `api_search`.
**Testy:** znana klasa ma oczekiwanych „used by"; klasa-liść ma pustą listę; brak duplikatów.

### Task 9: #21 — MODPLAN jako strukturalny JSON + `mod_plan`

**Files:** Create `src/tools/mod-plan.ts`, Test; Modify `src/prompts/create-mod.ts` i `modify-mod.ts`, `src/server.ts`.
**Cel:** zamiast freeform MODPLAN.md — strukturalny format (fazy, status, pliki, notatki architektury); narzędzie `mod_plan` czyta status, oznacza fazy done, generuje listę zadań następnej fazy.
**Testy:** create/read/update planu; oznaczenie fazy done; generowanie next-phase tasks.

### Task 10: #22 — Incremental asset index

**Files:** Modify `src/tools/asset-search.ts` (persist cache + mtime invalidation), ewent. `src/utils/cache.ts`; Test.
**Cel:** zamień session-scoped `cachedIndex` na on-disk cache inwalidowany po mtime plików — pierwsze wyszukanie w kolejnej sesji instant zamiast pełnego skanu `.pak` + katalogów.
**Testy:** cache zapisany/odczytany; zmiana mtime unieważnia odpowiedni wpis; cold vs warm start.

---

## Kryteria zamknięcia planu

- Wszystkie 10 pozycji: PR zmergowany + checklist repo + odhaczone w UPGRADE_IDEAS.md.
- Nowe narzędzia (`project_patch`, `script_check`, `mod_plan`, `mod` publish) zarejestrowane i w README.
- Wyniki dopisane tu; następny krok: Faza 5 (scraper refresh, #25 cross-ref validation, #26 component matrix).
