# TODO

## Bugs

### [BUG] [RESOLVED] `scenario_create_objective` - SlotKill ends up inside Layer_AI, not as direct LayerTask child
Investigated live on engine 1.7.0.54 with a compiling Game module — does not reproduce. A
`scenario_create type=objective` run produced the correct hierarchy (Slot as a direct child of
LayerTask, `Layer_AI`/`SlotAI` nested separately) and persisted correctly on save.
Regression fixture: `tests/fixtures/objective-hierarchy.layer`.

Root cause of the historical reports: the mod's Game script module failed to compile, so the
`SCR_ScenarioFramework*` component classes were unavailable to `SetVariableValue`/reparent calls
(likely combined with an older engine build). With a compiling Game module, `ParentEntity()` via
`EMCP_WB_ModifyEntity` nests entities correctly in the saved `.layer` file.

### [BUG] [RESOLVED] `m_eActivationType ON_TRIGGER_ACTIVATION` not settable via `setProperty`
Same root cause as above — non-reproducible on engine 1.7.0.54 with a compiling Game module.
`setProperty` correctly writes the bare enum value (`ON_TRIGGER_ACTIVATION`) and it persists on
save. See `tests/fixtures/objective-hierarchy.layer` for the captured evidence.

---

## Features / Improvements

### [FEAT] [DONE] Support for multiple SlotAI entities under Layer_AI
`scenario_create type=objective` now accepts `aiSpawnCount` (1-12) to place N SlotAI entities
under `Layer_AI`, each spawning one AI group. Single-count naming stays backwards compatible
(`${taskName}_SlotAI`); multi-count uses `${taskName}_SlotAI_${i}`.

### [FEAT] [DONE] `scenario_create_objective` — add `m_sSpawnRadius` / spawn offset support
Added `aiSpawnOffset` ('x y z') — applied incrementally to each SlotAI relative to the area
centre (SlotAI 1 stays at the centre, SlotAI 2 is offset by one increment, etc.). Verified live:
`move` on a reparented entity sets local (parent-relative) coords, which lands correctly relative
to the area centre since Area/LayerTask/Layer_AI are all unrotated with zero local offset from
each other.

### [FEAT] [NOT NEEDED] Write hierarchy directly to `.layer` file from `scenario_create_objective`
The nesting-persistence bug that motivated this was the compile-failure issue above, not an API
limitation — reparenting via `EMCP_WB_ModifyEntity` already produces a correct saved hierarchy, so
a direct `.layer`-file-write approach is unnecessary.
