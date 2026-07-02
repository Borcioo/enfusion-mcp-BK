# Spec: Pełna rozbudowa enfusion-mcp (fork Borcioo/enfusion-mcp-BK)

**Data:** 2026-07-03
**Status:** zatwierdzony przez użytkownika (brainstorm 2026-07-03)
**Repo:** `D:\Projekty\ArmaReforger\enfusion-mcp-BK` (fork `steffenbk/enfusion-mcp-BK`, v0.10.0)
**Projekt testowy:** `D:\Projekty\ArmaReforger\Central-Economy` (fork `CashewSan/Central-Economy`)

## Cel

Rozbudować MCP server `enfusion-mcp` tak, żeby agent (Claude) miał możliwie pełną
kontrolę nad Arma Reforger Workbench i zamkniętą pętlę pracy: pisze kod → hot-reload
→ play → czyta stan gry i logi → poprawia. Bez klikania użytkownika w Workbench.

Nadrzędny kontekst: narzędzie służy do prac nad modem Central Economy (DayZ-style
loot economy) dla Arma Reforger. Priorytety faz odzwierciedlają to, co najbardziej
przyspiesza tę pracę.

## Zasady pracy (obowiązują każdą pozycję)

1. **PR-friendly:** każda pozycja = osobna gałąź + PR do `Borcioo/enfusion-mcp-BK:main`,
   pisana tak, żeby dała się cherry-pickować do upstreamu (`steffenbk`).
2. **Checklist repo** (z `UPGRADE_IDEAS.md`) przy każdej zmianie:
   - testy Vitest (`npm run build && npm test` zielone),
   - aktualizacja `description` narzędzi w `src/tools/*.ts`,
   - aktualizacja promptów `src/prompts/create-mod.ts` / `modify-mod.ts` jeśli dotyczy,
   - aktualizacja tabeli narzędzi w `README.md` jeśli dotyczy,
   - odhaczenie pozycji w `UPGRADE_IDEAS.md` / `TODO.md` (strikethrough + „✅ Done (PR #N)"),
   - nowe narzędzia rejestrowane w `src/server.ts`.
3. **Kod i commity po angielsku** (konwencja repo). Dokumentacja robocza (specs/plany) po polsku.
4. **Doc-first:** postęp trackowany w plikach repo (spec, plan, UPGRADE_IDEAS, TODO),
   nie w kontekście rozmowy. Każda faza wykonywalna od zera po utracie kontekstu.
5. **Live smoke test** każdej zmiany dotykającej Workbencha: wywołanie przez MCP na
   działającym Workbench z projektem Central-Economy.

## Architektura istniejąca (skrót — pełna mapa w raporcie z audytu)

- **Offline layer:** indeks API (8 693 klasy, `data/api/`), wiki (258 stron), KB (48 plików
  `data/kb/`), generatory (skrypty/prefaby/configi/layouty/scenariusze), recipes (12 kategorii
  prefabów + ancestry resolver), walidacja modów, czytanie `.pak`.
- **Live layer:** TCP 127.0.0.1:5775 → Workbench NET API. Protokół: int32 wersja + Pascal
  stringi (clientId, "JsonRPC", payload JSON z `APIFunc`). 20 handlerów Enforce Script
  (`mod/Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_*.c`) wstrzykiwanych do aktywnego moda.
  Klient (`src/workbench/client.ts`): auto-launch z `-gproj`, recovery handlerów bez killa,
  dedupe launchy, timeouty (call 10 s, launch 90 s), limit odpowiedzi 10 MB.
- **Ograniczenie kluczowe:** handlery mutujące wymagają edit mode (w play mode
  `Workbench.GetModule(WorldEditor)` = null). Terrain tylko read-only.
- **Testy:** Vitest, 34 pliki, wszystkie offline/unit.
- **Node >= 20, ESM, deps:** MCP SDK, adm-zip, cheerio, zod.

## Fazy

### Faza 0 — Fundament (lokalna konfiguracja, bez PR)

1. `npm install && npm run build && npm test` w forku.
2. Rejestracja MCP w Claude Code z lokalnej ścieżki (NIE z npm):
   `claude mcp add --scope project enfusion-mcp -- node D:\Projekty\ArmaReforger\enfusion-mcp-BK\dist\index.js`
3. Konfiguracja (env albo `enfusion-mcp.config.json`):
   - `ENFUSION_WORKBENCH_PATH` — katalog Arma Reforger Tools (Steam),
   - `ENFUSION_PROJECT_PATH` — katalog z modami: `D:\Projekty\ArmaReforger`
     (uwaga: `Central-Economy/source/` zawiera `addon.gproj` — sprawdzić, czy
     `findFallbackGproj` znajduje gproj w podkatalogu `source/`; jeśli nie, dodać
     obsługę zagnieżdżenia albo symlink),
   - `ENFUSION_DEFAULT_MOD` — mod Central-Economy,
   - `ENFUSION_GAME_PATH` — katalog gry Arma Reforger (Steam).
4. Smoke test: `wb_diagnose` → `wb_launch` → `wb_state` → `api_search("SCR_BaseGameMode")`
   → `wb_reload`.

**Kryterium wyjścia:** pełna pętla connect → state → reload działa na Central-Economy;
`npm test` zielony.

### Faza 1 — Bugfixy z TODO.md

**Problem:** reparent encji scenario przez `EMCP_WB_ModifyEntity` nie utrwala się
poprawnie w `.layer` (Workbench spłaszcza/przestawia dzieci przy zapisie) — SlotKill
ląduje w Layer_AI zamiast jako bezpośrednie dziecko LayerTask. Osobno: enum
(`m_eActivationType`) nie da się ustawić przez `SetVariableValue`.

**Rozwiązanie (jedno na oba bugi):** zapis hierarchii scenario bezpośrednio do pliku
`.layer` zamiast składania przez API + reparent.

- Nowy moduł `src/formats/layer-writer.ts`: generowanie/wstawianie bloków `.layer`
  (format tekstowy Enfusion — reuse parsera `src/formats/enfusion-text.ts`).
- `scenario_create_objective` w `src/tools/wb-scenario.ts` przechodzi na layer-writer:
  buduje pełny blok Area → LayerTask → {Slot (bezpośrednie dziecko), Layer_AI → SlotAI}
  i zapisuje do pliku; potem każe Workbenchowi przeładować świat (zbadać: reload świata
  vs `wb_open_resource` vs restart WE — wybrać najlżejsze działające).
- Enum values pisane wprost w bloku tekstowym — omija ograniczenie `SetVariableValue`.
- FEAT-y z TODO przy okazji: parametr `aiSpawnCount` (N × SlotAI pod Layer_AI),
  `spawnOffset` (SlotAI odsunięty od centrum strefy).
- Testy: unit na strukturę wygenerowanego bloku (poprawne zagnieżdżenie, enum jako
  string, N slotów); live: scenario w Central-Economy world, weryfikacja przez
  `wb_entity_inspect` + odczyt pliku `.layer`.

**Kryterium wyjścia:** `ScenarioFramework` inicjalizuje task bez błędu
`missing m_SlotTask`; obie pozycje TODO odhaczone.

### Faza 2 — „Oczy" (3 nowe zdolności, kolejno)

#### 2.1 `wb_log` — logi i błędy kompilacji (UPGRADE_IDEAS #16)

Dziś agent nie widzi NIC z konsoli Workbencha — po nieudanym `wb_reload` zgaduje.

- **Ścieżka A (handler):** `EMCP_WB_GetLog.c` — zbadać, czy Workbench script API
  wystawia dostęp do console/log buffer (np. przez moduł ScriptEditor lub log callback).
- **Ścieżka B (fallback, pewna):** tail plików logów Workbencha z profile dir
  (`console.log`, `ScriptEditor.log` itp. — zlokalizować dokładne pliki podczas
  implementacji). Czysto Node.js, bez handlera.
- Narzędzie `wb_log`: parametry `lines` (ile ostatnich), `filter` (regex),
  `since` (timestamp/marker).
- Parser błędów kompilacji: wyciąga `plik:linia: komunikat`, automatycznie dokleja
  ±5 linii kodu z pliku źródłowego.
- Integracja: `wb_reload` po niepowodzeniu automatycznie dołącza sparsowane błędy
  do swojej odpowiedzi.

**Kryterium wyjścia:** celowo zepsuty skrypt w Central-Economy → `wb_reload` zwraca
błąd z plikiem, linią i kontekstem kodu.

#### 2.2 `wb_game_state` — inspekcja świata w play mode

Dziś play mode = czarna dziura (WorldEditor null → wszystkie handlery odmawiają).

- Nowy handler `EMCP_WB_GameState.c`: w play mode czyta świat przez `GetGame()` /
  `GetGame().GetWorld()` — **read-only**: lista encji (filtrowana po klasie/prefabie,
  paginowana), pozycje, gracze, komponenty wybranej encji, czas świata.
- Narzędzie `wb_game_state` z akcjami `list_entities`, `inspect_entity`, `players`, `world_info`.
- Wprost pod testy CE: „czy CE_ItemSpawningSystem zespawnował itemy?" — lista encji
  po prefabie w trakcie play testu.
- Ryzyko: kontekst skryptowy NET API w play mode może nie mieć dostępu do game world —
  zbadać na początku fazy; jeśli zablokowane, plan B: mod-side komponent debug
  (w Central-Economy) wypisujący stan do logu + odczyt przez `wb_log` z 2.1.

**Kryterium wyjścia:** podczas play testu CE agent listuje zespawnowane itemy
z pozycjami bez zatrzymywania gry — albo udokumentowane „nie da się, bo X" + działający plan B.

#### 2.3 `wb_screenshot` — capture viewportu

- **Ścieżka A:** akcja menu przez istniejący `wb_execute_action` (jeśli Workbench ma
  akcję screenshot) → plik → zwrot ścieżki.
- **Ścieżka B:** `System.RunCommandline` / API workbenchowe do zrzutu.
- **Ścieżka C (fallback):** zrzut okna procesu Workbencha z Node (PowerShell/nircmd) —
  brzydkie, ale działa zawsze.
- Narzędzie zwraca ścieżkę pliku PNG (agent czyta przez Read — multimodal).
- Jeśli żadna ścieżka nie działa sensownie: udokumentować w spec czemu i zamknąć pozycję.

**Kryterium wyjścia:** agent widzi viewport po rozstawieniu encji — albo udokumentowana rezygnacja.

### Faza 3 — Pozostałe S-ki z UPGRADE_IDEAS

- **#10 Dry-run** dla narzędzi mutujących (`mod` scaffold, `script_create`, `prefab`,
  `config_create`, `layout_create`, `project` write): parametr `dryRun` → zwraca co
  powstałoby, bez zapisu. Generalizacja istniejącego zachowania `script_create`
  przy istniejącym pliku.
- **#11 Konsolidacja** `project_browse`/`game_browse`: wspólny `src/utils/dir-listing.ts`
  (`listDirectory`, `FILE_TYPE_MAP` — ujednolicić `.emat`/`.sounds`, `formatSize`, `DirEntry`).

### Faza 4 — M-ki (kolejność wg wartości dla pracy nad CE)

1. **#24 Diff-based patching** — narzędzie `project_patch`: edycja plików przez
   old-string→new-string (jak Edit w Claude Code), zamiast full-file rewrite.
   Wariant strukturalny (add method / modify method body) jako stretch — tylko jeśli
   diff-owy okaże się niewystarczający.
2. **#13 `script_check`** — walidator sygnatur: klasa + metoda → istnieje? Jeśli blisko,
   zwróć poprawną sygnaturę (reuse `utils/fuzzy.ts`).
3. **#23 Multi-mod workspace** — `ENFUSION_PROJECT_PATH` wskazuje katalog z wieloma
   addonami; narzędzia przyjmują opcjonalny `modName`; `project` browse listuje addony.
   Uwzględnić layout `Central-Economy/source/` (gproj w podkatalogu).
4. **NOWE: `mod` action=publish** — pack + publikacja na Workshop przez Workbench CLI
   (`-wbModule=ResourceManager`, zbadać dokładne parametry publish/builddata podczas
   implementacji). Luka spoza UPGRADE_IDEAS — dziś `workshop_info` tylko czyta metadane.
5. **#18 Pitfalls injection** (`data/pitfalls.json`, dobór wg kontekstu tworzenia) +
   **#17 snippety w patterns** (`codeExamples` w `data/patterns/*.json`) — pisane
   z realnych gotchy zebranych w fazach 0-3, nie zgadywane z góry.
6. **#19** fix suggestions w `mod_validate` (strukturalne obiekty fix przy issue),
   **#20** used-by backlinks w search engine (reverse index),
   **#21** MODPLAN jako strukturalny JSON + narzędzie `mod_plan`,
   **#22** incremental asset index (persystentny cache z inwalidacją po mtime).

### Faza 5 — L + dane

- **Scraper refresh:** naprawa parsowania enumów (dziś 0 w indeksie), briefs klas
  (85% pustych), `hierarchy.json` (pusty); pin wersji gry w metadanych indeksu
  (`data/api/meta.json`: wersja Reforgera + data scrape). `npm run scrape` z Playwright.
- **#25 Cross-ref validation on write:** `project` write skryptu `.c` → regex-owa
  ekstrakcja wywołań → weryfikacja względem indeksu → warningi inline.
- **#26 Component compatibility matrix:** skan base-game `.et` podczas indeksowania
  assetów → mapa „jakie komponenty współwystępują na jakich typach encji" →
  tryb w `api_search` / podpowiedzi w `prefab`.

## Poza zakresem (świadomie)

- Edycja terenu (sculpt/paint/drogi), animation graph live, particle/audio editory —
  WorldEditorAPI tego nie wystawia; bez zmian silnika nieosiągalne z NET API.
- Embeddingi/wyszukiwanie semantyczne w indeksie — lexical + fuzzy wystarcza.
- Własne narzędzia CE-specific (np. `ce_validate_config`) — osobny spec, kiedy praca
  nad CE ich zażąda.

## Testowanie

- **Unit (Vitest):** każda pozycja; konwencja repo (`tests/` lustrzane do `src/`).
- **Handlery `.c`:** brak unit testów (kompilują się w Workbench) — test = wywołanie
  przez MCP na żywym Workbench + asercja odpowiedzi. Smoke checklist w
  `docs/superpowers/specs/` po każdej fazie live.
- **Regresja:** `npm run build && npm test` przed każdym PR.

## Ryzyka

| Ryzyko | Mitygacja |
|---|---|
| NET API nieudokumentowane — logi/screenshot/game-state mogą być niedostępne z handlera | Każda pozycja Fazy 2 ma plan B (tail plików, mod-side debug, zrzut okna); wynik badania dokumentowany w spec zamiast cichej porażki |
| Update Reforgera łamie handlery/recipes/indeks | Pin wersji gry w metadanych; smoke test Fazy 0 po każdym updacie gry |
| Scraper kruchy (Playwright + BIKI, cookies) | Faza 5 na końcu; scrape czysto lokalny gdzie się da (`scrape:local`) |
| Utrata kontekstu rozmowy (tokeny) | Ten spec + plan implementacji w repo; postęp w UPGRADE_IDEAS/TODO (strikethrough + nr PR); każda faza startowalna od zera |
| Workbench dzieli NET API z innymi klientami (Blender plugin) | Nie killować procesu WB (już respektowane w `recoverMissingHandlers`) |

## Kolejność wykonania i kryterium „done"

Fazy sekwencyjnie 0→5; wewnątrz fazy pozycje w podanej kolejności. Pozycja jest „done"
gdy: PR zmergowany do forka + checklist repo odhaczony + (dla live) smoke test przeszedł.
Projekt jest „done" gdy wszystkie fazy zamknięte albo pozycje jawnie przeniesione do
„poza zakresem" z uzasadnieniem.
