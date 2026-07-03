# Faza 5: Data Quality + L-tier — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Domknąć UPGRADE_IDEAS: #25 (cross-ref validation on write), #26 (component compatibility matrix), oraz scraper refresh (briefy + enumy + wiki) oparty na FAKTACH z rozpoznania, nie założeniach.

## Rozpoznanie (2026-07-03) — fundament planu

- Scraper ma dwa źródła: `src/scraper/source-local.ts` (lokalne `.c`/`.pak` z Workbencha) i `src/scraper/source-remote.ts` (Doxygen HTML z `community.bistudio.com/wikidata/external-data/arma-reforger/{EnfusionScriptAPIPublic|ArmaReforgerScriptAPIPublic}`). Parser: `src/scraper/doxygen-parser.ts` (briefy z `td.desc` i `div.contents>p`).
- Obecne dane: enfusion 812 klas, **27% z briefem, 0 enumów**. Prawdopodobnie zbudowane z `--source local`. Oficjalny Doxygen (remote) MA briefy + strony enumów.
- BIKI/wikidata jest za Cloudflare. Model z dayz-rag (`dayz-search-wiki-index/index.py`): MediaWiki `api.php` + `list=categorymembers` + harvestowany `cf_clearance` cookie + matching User-Agent (plain HTTP, nie Playwright). To lepszy wzorzec niż istniejący `scrape-wiki.ts` (Playwright).

## Global Constraints

- Repo: `enfusion-mcp-BK`, branch bazowy `main` (d695781, po Fazie 4, 669 pass/1 skip).
- Angielski w kodzie/commitach; `feat:`/`fix:`/`test:`/`docs:`. Task = gałąź + PR do `Borcioo/enfusion-mcp-BK:main`. Przed commitem `npm run build && npm test` zielone.
- Checklist repo: testy, `description`, README, `UPGRADE_IDEAS.md` odhaczenie.
- KAŻDY task zaczyna od przeczytania obecnego stanu (część bywa już zrobiona).
- Scraper (Task 3) wymaga sieci do BIKI (CF) — może wymagać interakcji użytkownika (cookie). Robić OSTATNI, degradować uczciwie.

---

### Task 1: #25 — Cross-Reference Validation on Write

**Files:** Modify `src/tools/project.ts` (write action) i/lub `src/tools/project-patch.ts`; reuse `src/index/search-engine.ts`; Test.
**Cel:** gdy zapisywany jest plik `.c`, lekka statyczna kontrola: regex-owa ekstrakcja wywołań metod / referencji klas → weryfikacja względem indeksu API (reuse `hasClass`, method lookup, `getInheritedMembers`, fuzzy z `script_check`) → zwróć WARNINGI inline (nie blokuj zapisu). Łapie zhalucynowane API zanim moder skompiluje.
**Uwaga:** to NIE ma blokować zapisu ani generować false-positives na lokalnych/modowanych klasach (klasy zdefiniowane w tym samym modzie nie są w indeksie bazowym — nie zgłaszaj ich jako „nieznane"). Rozważ: zbierz nazwy klas/metod zdefiniowanych lokalnie w projekcie i wyklucz je z ostrzeżeń.
**Testy:** zapis z realną metodą → brak warningu; z metodą zhalucynowaną na znanej klasie → warning z sugestią (reuse script_check); lokalnie zdefiniowana klasa → brak false-positive; warning nie blokuje zapisu (plik powstaje).
**Acceptance:** zapis skryptu z `SCR_BaseGameMode.NonexistentMethod()` → warning „not found, did you mean…", plik zapisany.

### Task 2: #26 — Component Compatibility Matrix

**Files:** Modify `src/tools/asset-search.ts` (rozszerz indeksowanie o skan `.et`) lub nowy `src/index/component-matrix.ts`; `src/tools/api-search.ts` (tryb `type:"components"`); Test.
**Cel:** zbuduj mapę „jakie komponenty współwystępują na jakich typach encji" skanując base-game `.et` (przez pak-reader — naprawiony w Fazie 2). Tryb w `api_search` (np. `type:"components"` albo nowe `component_search` rozszerzenie): dla typu encji (GenericEntity, SCR_ChimeraCharacter) zwróć typowo dołączane komponenty. Zapobiega dołączaniu niekompatybilnych komponentów.
**Wydajność:** skan `.et` to dużo plików — reuse persystentnego cache z Fazy 4 (#22, `asset-index-cache.ts`) albo osobny cache z mtime-inwalidacją; nie skanuj przy każdym wywołaniu.
**Testy:** na małym zestawie fixture `.et` (kilka encji z komponentami) matrix zwraca poprawne współwystępowania; nieznany typ encji → pusto; cache dziala.
**Acceptance:** „jakie komponenty ma zwykle GenericEntity broni" zwraca realny zestaw z base game.

### Task 3: Scraper refresh (briefy + enumy + wiki) — RESEARCH-FIRST, ostatni

**Files:** Modify `src/scraper/doxygen-parser.ts` (enum extraction), `src/scraper/source-remote.ts` (CF cookie), ewent. `scripts/scrape.ts`; `data/api/*` (regenerowane); pin wersji w `data/api/meta.json`.

- [ ] **Step 1: RESEARCH — source vs extraction gap (bez wielkiego scrape)**
  Pobierz JEDNĄ stronę klasy z remote Doxygen (np. `interfaceSCR__BaseGameMode.html` z `EnfusionScriptAPIPublic`) — sprawdź czy `td.desc`/`div.contents>p` FAKTYCZNIE zawierają briefy i czy istnieją strony enumów. Jeśli CF blokuje bez cookie → udokumentuj i przejdź do Step 2 (cookie). Wynik determinuje resztę:
  - Briefy SĄ w remote HTML → remote re-scrape naprawi 27%→wysoko. Extraction gap = tylko enumy.
  - Briefów NIE MA nawet w remote → source gap; briefów nie da się „doscrapeować", tylko z `.c` komentarzy jeśli są. Udokumentuj i nie obiecuj cudów.

- [ ] **Step 2: Cookie/CF (jak potrzebny)** — zaadaptuj model dayz-rag: `cf_clearance` + User-Agent z realnej przeglądarki, cache w pliku (env override), plain HTTP w `source-remote.ts`. Interaktywny setup jak `--setup-cookie` (WYMAGA użytkownika — jasno zakomunikuj). Jeśli cookieless przechodzi — tym lepiej.

- [ ] **Step 3: Enum extraction** — dodaj do `doxygen-parser.ts` parsowanie stron enumów Doxygen (Enfusion reprezentuje enumy jako osobne strony / sekcje). TDD na zapisanym fixture HTML strony enuma (zapisz realną stronę jako `tests/fixtures/`). Cel: `data/api` z niepustymi enumami.

- [ ] **Step 4: Remote re-scrape + pin wersji** — `npm run scrape -- --source remote` (jeśli CF przejdzie); zapisz `data/api/meta.json` z wersją gry + datą. Zmierz brief coverage przed/po.

- [ ] **Step 5: Wiki refresh (opcjonalnie, jeśli czas)** — zamień Playwright `scrape-wiki.ts` na MediaWiki API (`api.php` + `categorymembers`) + cookie, wzorem dayz-rag; albo odśwież `data/wiki/export.xml` przez Special:Export i przez istniejący `parse-wiki-export.ts`.

**Uwaga:** Task 3 jest kruchy i sieciowy. Jeśli CF/cookie blokuje bez interakcji użytkownika, dostarcz enum-extraction (kod, testowalny na fixture) i UDOKUMENTUJ procedurę remote re-scrape jako krok manualny dla użytkownika, zamiast wymuszać.

---

## Kryteria zamknięcia planu

- #25, #26: PR zmergowany + testy + odhaczenie. #25 bez false-positives na klasach lokalnych; #26 z cache.
- Scraper: enum-extraction w kodzie + testowany na fixture; remote re-scrape wykonany LUB udokumentowany jako manualny (z wynikiem rozpoznania source-vs-extraction). meta.json z wersją.
- 100% UPGRADE_IDEAS zaadresowane (zrobione albo jawnie „poza zakresem/manualne").
- Follow-upy z Faz 2/4 domknięte lub przeniesione: script_check overload fix, wb_game_state live E2E.
