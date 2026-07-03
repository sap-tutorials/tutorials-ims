# Knowledge Graph Architecture

The knowledge graph (KG) is a graph of SAP developer learning objects — tutorials,
concepts, products, tags, missions, and groups — enriched with external resources
from curated corpora. Concept pages at `/concepts/<slug>/` surface related resources
from all corpora, ordered by phase-assigned priority.

## Graph structure

Nodes include: `tutorial`, `concept`, `mission`, `group`, `product`, `category`,
`tag`, and external-resource types (see corpora below).

Predicates include: `teaches`, `requires`, `relatedTo`, `taggedWith`, `aboutProduct`,
`inCategory`, `coCompletedWith`, `partOf`, `covers`.

## External resource corpora (Phase 4 series)

Each sub-phase adds one corpus with:
- A `fetch-*` cron job that fills rows in `CommunityEvents` (or `LearningJourneys`,
  etc.) and links rows to concepts via `*ConceptLinks` join tables.
- A `type` entry in `srv/lib/kg-resource-type-config.js` with icon, labels, priority,
  and `renderMeta`.
- A union extension in `hugo-apps/src/related-graph/types.ts` (`NodeType` +
  `OtherResource.type`).
- A Hugo template section appended to `hugo/layouts/concepts/single.html`.
- A frontmatter emission block in `scripts/fetch-concepts.ts`.

### Phase 4.1 — Learning journeys (#447)

SAP Learning Journeys from learning.sap.com. Weekly cron. Priority 10.

### Phase 4.2 — Blog posts (#447 §9)

SAP Community blog posts. Daily cron. Priority 20.

### Phase 4.3 — Discovery missions (#447 §8)

SAP Discovery Center missions. Weekly cron. Priority 30.

### Phase 4.4 — Videos (#447 §9)

SAP Developers YouTube videos. Daily cron. Priority 40.

### Phase 4.5 — API docs (#746)

api.sap.com authority documentation. Monthly cron. Priority 50.

### Phase 4.6 — Code samples (#747)

SAP-samples GitHub repositories. Weekly cron. Priority 60.

### Phase 4.7 — Help docs (#748, extended by #860)

Documentation from help.sap.com, cap.cloud.sap, ui5.sap.com, and
architecture.learning.sap.com (SAP Architecture Center). Weekly cron.
Priority 70.

### Phase 4.8 — SAP community events (#765)

SAP CodeJams, Devtoberfest, TechEd, and user-group events surfaced as
`community-event` graph nodes. Predicate: `covers`. TTL: date-aware via
`endDate + 30 days` (first live consumer of the reserved grace-period
branch introduced in Phase 4.3 for trials).

**Sources:** Khoros community-groups REST API (CodeJams) and RSS
(Devtoberfest). Native `fetch` — no MCP transport. Vendored JS ports live
under `srv/lib/events/`.

**Cron:** `fetch-community-events`, twice-weekly on Mon+Thu 04:31 UTC.

**Seed CLI:** `node scripts/seed-community-events.cjs --commit`
(also available as `AdminService.seedCommunityEvents(commit=true)` in the
admin UI).

**Fields:** `eventType`, `source`, `title`, `description` (synthesized
when upstream omits), `url`, `location`, `scope` (local/regional/virtual/
global), `virtualOrInPerson`, `startDate`, `endDate`.

**Explicit non-goals:** capacity/seat modelling (not in upstream payload),
geographic personalization (deferred to a future `Users.region` field).

**Spec:** `docs/superpowers/specs/2026-07-03-765-phase4.8-community-events.md`

## Sidebar integration (Phase 5 / #850)

`SidebarPanel.vue` and `ExpandedPanel.vue` are data-driven since #850. Adding a
new corpus requires:
1. One `RESOURCE_TYPE_CONFIG` entry in `srv/lib/kg-resource-type-config.js`
2. TS union widening in `hugo-apps/src/related-graph/types.ts`

No per-type `v-if` / `v-else-if` branches are needed — the sidebar reads
`typeConfig` from the wire and renders all types generically.

## Concept-page layout sections

Sections in `hugo/layouts/concepts/single.html` append in priority order:

| # | Section | data-kg-section | Phase |
|---|---------|----------------|-------|
| 1 | Learning journeys | `learning-journeys` | 4.1 |
| 2 | Help docs | `help-docs` | 4.7 |
| 3 | Blog posts | `blog-posts` | 4.2 |
| 4 | Discovery missions | `discovery-missions` | 4.3 |
| 5 | Videos | `videos` | 4.4 |
| 6 | API docs | `api-docs` | 4.5 |
| 7 | Code samples | `samples` | 4.6 |
| 9 | Code samples (alias) | `samples` | 4.6 |
| 10 | Upcoming hands-on events | `community-events` | 4.8 |

## Resource type config reference

See `srv/lib/kg-resource-type-config.js` — single source of truth for icon, labels,
priority, and `renderMeta` per type. Tests: `test/unit/kg-resource-type-config.test.js`.
