# #919 Task 0 probe notes

**Date:** 2026-07-04
**Ran:** `npx cds bind --exec --profile hybrid -- node ./_probe.cjs` against `tutorials-hana` on `tutorial-system/dev`.

## Column-name findings

All confirmed against live DEV HANA — no CDS-generation surprises:

| CDS Association | HANA column | Nullable? |
|---|---|---|
| `TutorialConceptLinks.extendsTutorial` | `EXTENDSTUTORIAL_ID` NVARCHAR(36) | yes |
| `TutorialConceptLinks.tutorial` | `TUTORIAL_ID` NVARCHAR(36) | yes |
| `TutorialConceptLinks.concept` | `CONCEPT_ID` NVARCHAR(36) | yes |
| `CompletionPathItems.tutorial` | `TUTORIAL_ID` NVARCHAR(36) | yes |
| `CompletionPathItems.path` | `PATH_ID` NVARCHAR(36) | yes |
| `Missions.group` | `GROUP_ID` NVARCHAR(36) | yes |
| `ConceptEdges.source` | `SOURCE_ID` NVARCHAR(36) | yes |
| `ConceptEdges.target` | `TARGET_ID` NVARCHAR(36) | yes |
| `TutorialTags.tutorial` | `TUTORIAL_ID` NVARCHAR(36) | NOT NULL |
| `TutorialTags.tag` | `TAG_ID` NVARCHAR(36) | NOT NULL |
| `MissionCategories.mission` | `MISSION_ID` NVARCHAR(36) | yes |
| `MissionCategories.category` | `CATEGORY_ID` NVARCHAR(36) | yes |
| `CoCompletions.sourceSlug` | `SOURCESLUG` NVARCHAR(120) | NOT NULL (key) |
| `CoCompletions.targetSlug` | `TARGETSLUG` NVARCHAR(120) | NOT NULL (key) |
| `Tags.name` | `NAME` NVARCHAR(255) | yes |
| `Tags.label` | `LABEL` NVARCHAR(255) | yes |
| `Categories.slug` | `SLUG` NVARCHAR(64) | yes |
| `Missions.slug` | `SLUG` NVARCHAR(255) | yes |
| `Groups.slug` | `SLUG` NVARCHAR(255) | yes |

## Delta from the plan draft

- **`CompletionPathItems` sort column is `ITEMORDER`, not `SORTORDER`** — the hybrid-test fixture in Task 8.3 needs the correct column name. Recorded here so Task 8 uses it.
- **`Categories.slug` is nullable** — plan's `WHERE SLUG IS NOT NULL` filter on the category vertex arm is warranted defensively (even though it's `@mandatory` at the CDS layer, HANA doesn't enforce that for CSV-seeded rows).
- **`Missions.slug` is nullable** — plan's filter is warranted.

All view SQL in later tasks uses these confirmed column names as-is.

## QA_MIRROR decision

`db-qa/src/views/` **does not exist**. Files under `db-qa/src/procedures/` (KG_PATH_V2 etc.) are stubs; there are no view mirrors. QA HDI reads shared view definitions via the shared source tree at `db/src/views/`.

**QA_MIRROR: no**

Task 7 is therefore a **no-op** — skip Steps 7.2, land only Step 7.3 (documentation note).

## Downstream consumers

The workspace declaration at `db/src/graph/KG_PG_WORKSPACE.hdbgraphworkspace`:

```
GRAPH WORKSPACE "KG_PG_WORKSPACE"
  EDGE TABLE "KG_PG_EDGES_V"
    SOURCE COLUMN "SOURCE"
    TARGET COLUMN "TARGET"
    KEY COLUMN "EDGE_KEY"
  VERTEX TABLE "KG_PG_VERTICES_V"
    KEY COLUMN "VERTEX_KEY"
```

Declares only column names — does NOT pin type widths. Widening `EDGE_KEY` from `NVARCHAR(400)` to `NVARCHAR(600)` is safe (Task 1 verifies with a defensive-first deploy).
