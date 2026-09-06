# External SAP Channels — Site Integration Design

*Design spec for incorporating the consolidated 238-channel SAP developer-channels dataset into developers.sap.com as a living, curated, navigable part of the site.*

- **Date:** 2026-09-04
- **Status:** Draft for review
- **Source dataset:** `External-SAP-Channels-Complete.json` (238 channels; schema_version 2.1.0)
- **Related surfaces:** verb-lane shelves (`db/homepage.cds` → `HomepageShelves`), topic pages (`/topics/*` Hugo taxonomy, `topic_clusters.json`), Knowledge Graph external content (`db/external-content.cds`)

> **CDS note:** All entity shapes below are proposals grounded in the existing `db/homepage.cds` conventions (`cuid`, `managed`, `authoringStatus`, `badge`, link-health fields). Actual CDS authoring in the implementation phase must be validated with `cds-mcp` per project rules before landing.

---

## 1. Context & problem

developers.sap.com currently surfaces **internal content** (tutorials, missions, blogs, videos, events) plus a **verb-scoped set of curated external links** (`HomepageShelves`, badged `THIRD_PARTY`). The wider world a developer actually lives in — 238 channels spanning portals, docs, GitHub, package registries, YouTube, podcasts, community Q&A, user groups, and independent trainers — is not represented on the site as a first-class, navigable thing.

Two gaps:

1. **Coverage gaps on verb-lane shelves.** The four shelves (`START_HERE`/`REFERENCE`/`TOOLS`/`KEEP_CURRENT`) have thin spots the dataset can fill with best-in-class links.
2. **No home for the breadth.** ~1/3 of the trusted developer surface is community-run (Stack Overflow, Reddit, Slack, user groups, open-source projects, independent trainers) and the site surfaces none of it. There is no per-topic "related resources," no browsable directory, and no way for the community to propose additions.

**A raw list of 238 links is not the goal.** The value is in *curation, clustering, and navigation* — guiding a developer to the right channel at the right moment.

## 2. Goals

- A **single living source of truth** for external channels, re-ingestable as the dataset evolves.
- **Fill verb-shelf gaps** with a curated subset (Surface A).
- A **`/channels` destination** — clustered, explained, faceted, browsable — as the deep home for the full set (Surface B).
- **Per-topic "related channels"** woven onto `/topics/*` and tutorial pages via a topic crosswalk (Surface C).
- **Editorial clustering + navigation** so the breadth reads as guided, not dumped.
- A **community submission & moderation loop** (propose add/change/remove → SAP review → publish).
- **Admin-UI/DB-driven curation** consistent with the existing shelf admin apps and Tom's DB-over-env preference.

## 3. Non-goals (YAGNI)

- Full Knowledge-Graph ingestion of channels (PageRank/community detection over channels). Deferred; revisit only if per-topic relevance proves insufficient.
- Auto-crawling channel content (feeds, subscriber counts live). Metadata is refreshed by re-ingesting an updated dataset, not by live scraping.
- Personalized channel recommendations. The `personaTags` primitive exists on shelves; we do not build channel-level personalization in this scope.
- Replacing the existing `HomepageShelves` third-party mechanism. We *feed* it, not replace it.

## 4. Architecture overview

One ingestion pipeline produces normalized rows in a new `Channels` entity. Three surfaces derive from it; two supporting subsystems (collections, crosswalk) and one workflow (submissions) hang off it.

```text
External-SAP-Channels-Complete.json
  → scripts/seed-channels.cjs  (normalize + idempotent upsert + status reconcile)
      → Channels (source of truth, HANA)
         ├── Surface A: curated subset → HomepageShelves (verb lanes)      [reuse existing]
         ├── Surface B: /channels feed → Vue island directory              [new]
         │     └── ChannelCollections (+ items)  — editorial clusters
         ├── Surface C: ChannelTopicMap crosswalk → /topics/* + tutorials  [new]
         └── ChannelSubmissions → admin moderation queue → mutate Channels [new]
```

## 5. Data model

### 5.1 `Channels` (source of truth)

Mirrors the source dataset fields plus lifecycle/curation columns. Dedup key is the source `id` (e.g. `portal-001`); `contentHash` drives idempotent re-ingest.

```cds
type ChannelOwnerType : String enum {
  SAP_Official; SAP_Developer_Advocate; SAP_Executive;
  Community_Member; Community_Organization; User_Group;
  Third_party_Training; Third_party_Media; Third_party_Platform;
}
type ChannelStatus : String enum { Active; Archived; Closed; Discontinued; EOL; }

@assert.unique.sourceId: [sourceId]
entity Channels : cuid, managed {
  sourceId       : String(40)  @mandatory;   // "portal-001" — dedup/re-ingest key
  name           : String(200) @mandatory;
  url            : String(500) @mandatory;
  relatedUrls    : array of String(500);
  aliases        : array of String(120);
  purpose        : String(1000);             // cleaned of [cite:] markers at ingest
  notes          : String(1000);
  ownerName      : String(120);
  ownerType      : ChannelOwnerType @assert.range;
  isSapOwned     : Boolean default false;
  category       : String(60);               // "Portal", "GitHub Repository", ...
  subcategory    : String(80);
  platform       : String(40);               // "Web", "YouTube", "GitHub", ...
  status         : ChannelStatus default 'Active' @assert.range;
  focusAreas     : array of String(60);
  tags           : array of String(40);
  updateFrequency: String(40);
  githubStars    : Integer;
  subscribers    : Integer;

  // ── curation / lifecycle (admin-editable; absent from ingest so re-seed never wipes) ──
  isPublished    : Boolean default true;     // show in directory
  isFeatured     : Boolean default false;    // eligible for verb shelves / topic bands
  editorialNote  : String(800);              // curator prose overriding purpose on cards
  contentHash    : String(64);               // hash of source fields → skip unchanged on re-ingest
  ingestBatch    : String(40);               // dataset generated-date; drives retire-on-absence
  linkStatus     : String(20) default 'UNKNOWN';
  linkStatusOverride : String(20);
  lastChecked    : Timestamp;
}
```

### 5.2 `ChannelCollections` + `ChannelCollectionItems` (editorial clusters)

The "intelligent grouping + explanations" layer. A collection is a named, ordered, explained set of channels — LLM-drafted, human-reviewed (reuse the `AuthoringStatus` enum already in `homepage.cds`).

```cds
entity ChannelCollections : cuid, managed {
  slug            : String(80)  @mandatory;  // "getting-started-abap-cloud"
  title           : String(140) @mandatory;
  intro           : String(1200);            // narrative: what this cluster is, how to navigate it
  sortOrder       : Integer default 100;
  isPublished     : Boolean default false;
  authoringStatus : AuthoringStatus default 'BLANK';  // BLANK | AI_SEEDED | REVIEWED
  items           : Composition of many ChannelCollectionItems on items.collection = $self;
}
entity ChannelCollectionItems : cuid {
  collection : Association to ChannelCollections;
  channel    : Association to Channels;
  sortOrder  : Integer default 100;
  blurb      : String(280);   // optional per-item "why it's in this collection / read this first"
}
```

### 5.3 `ChannelTopicMap` (Surface C crosswalk)

Maps a channel to a site topic tag (the hierarchical `software-product>…` vocabulary in `hugo/data/tags.json`). LLM-drafted, human-reviewed.

```cds
@assert.unique.pair: [channel_ID, topicTag]
entity ChannelTopicMap : cuid, managed {
  channel         : Association to Channels @mandatory;
  topicTag        : String(140) @mandatory;   // "software-product>sap-business-technology-platform"
  relevance       : Integer default 50;       // 0-100, orders the per-topic band
  authoringStatus : AuthoringStatus default 'AI_SEEDED';
}
```

### 5.4 `ChannelSubmissions` (community moderation queue)

```cds
type SubmissionKind   : String enum { ADD; EDIT; REMOVE; }
type SubmissionStatus : String enum { PENDING; APPROVED; REJECTED; }
entity ChannelSubmissions : cuid, managed {
  kind          : SubmissionKind   @mandatory @assert.range;
  targetChannel : Association to Channels;      // null for ADD
  proposed      : LargeString;                  // JSON payload of proposed fields
  rationale     : String(1000);                 // submitter's "why"
  submitterId   : String(120);                  // XSUAA user id
  status        : SubmissionStatus default 'PENDING' @assert.range;
  reviewerId    : String(120);
  reviewNote    : String(800);
}
```

## 6. Ingestion pipeline

`scripts/seed-channels.cjs` (follows the established `seed-*.cjs` convention):

1. Read the dataset JSON. **Clean** each `purpose`/`notes` of `[cite: …]` markers.
2. Normalize enums (`owner_type` → `ChannelOwnerType`, `status` → `ChannelStatus`; map `"Entering EOL"`→`EOL`, `"Active (Canonical …)"`→`Active` + note).
3. Compute `contentHash` per row from source fields.
4. **Idempotent upsert on `sourceId`** (SELECT-then-UPDATE-or-INSERT, per the project's slug-upsert rule): unchanged hash → skip; changed → update source fields only, never the admin-curated columns (§5.1); new → insert.
5. **Retire on absence:** rows whose `sourceId` is absent from the newest `ingestBatch` are set `status` per the dataset's correction notes (or flagged for review), never hard-deleted.
6. Honor the dataset's `corrections_and_historical_notes` to auto-mark retired channels (openSAP, HANA Academy YT, ONE Support Launchpad).

Re-running with an updated dataset is safe and non-destructive to curation.

## 7. Surface A — fill verb-lane shelves

- A curated subset (`isFeatured = true`) is promoted into `HomepageShelves`.
- **Category → shelf** default mapping (admin-overridable): Docs/Portal→`REFERENCE`; GitHub/registries/tools→`TOOLS`; YouTube/podcast/news/blogs→`KEEP_CURRENT`; Learning/entry portals→`START_HERE` **for SAP-official only** (third-party never lands in `START_HERE`, preserving the existing rule).
- **Focus_areas/tags → verb** mapping via a small lookup (abap/rap→`build`/`model`; integration→`integrate`; ops/admin→`operate`; ai→`AI`; onboarding/tutorials→`learn`).
- Promotion generates `HomepageShelves` rows carrying `badge=THIRD_PARTY` for community items, `isExternal=true`, and reuses existing link-health + `whyItMatters`. Community channels honor the §11 governance bar.

## 8. Surface B — `/channels` directory

- **Route:** top-level `/channels` (see Open Questions for verb-lane nesting alternative). Served via the HANA-BLOB content-page pattern (`page-channels`) consistent with the Phase-2 flip, or as a Hugo page hosting a Vue island fed by a new CAP feed `/build/channels` — decide in the plan; both are established patterns.
- **Landing structure (top → bottom):**
  1. Short intro (what this is, how developers use these channels).
  2. **Editorial collections** (`ChannelCollections`) — the lead navigation: a handful of explained clusters ("Get started with ABAP Cloud", "Stay current on AI", "Best community voices"), each with its intro and ordered items.
  3. **Faceted full list** — filter by category, focus area, SAP-official vs community, platform, status; text search over name/purpose/tags.
  4. **Per-channel detail** — name, link, purpose/`editorialNote`, owner, badges (SAP-official / community / third-party), related links, link-health.
- Community items clearly badged throughout.

## 9. Surface C — per-topic "related channels"

- A "Go deeper / follow" band renders on `/topics/*` term pages and (optionally) tutorial pages, sourced by joining `ChannelTopicMap` on the page's primary topic tag, ordered by `relevance`, capped (e.g. top 5), community items badged.
- The crosswalk (`ChannelTopicMap`) is **LLM-drafted then human-reviewed**: a generation pass proposes `(channel → topicTag, relevance)` rows as `AI_SEEDED`; a curator promotes to `REVIEWED` in the admin UI before they go live. Only `REVIEWED` (or a config-gated `AI_SEEDED`) rows render.
- `/topics/*` is currently a Hugo taxonomy; the band needs either a baked `channels_by_topic.json` data file (build-time) or a small island calling the feed. Prefer the baked-data approach to match existing `/topics/` rendering.

## 10. Clustering & navigation

Two tiers, so the page is guided not dumped:

- **Tier 1 — deterministic facets** (free from `Channels` fields): category, focus area, SAP-vs-community, platform, status. The escape hatch for power users.
- **Tier 2 — editorial collections** (`ChannelCollections`): curated, ordered, *explained*. This is the primary navigation and where "good explanations around navigating the content" live. Seeded by an LLM clustering pass over `focus_areas`/`tags`/`purpose`, then human-reviewed. Each collection carries a narrative `intro` and optional per-item `blurb`.

## 11. Governance — community channels

Per Tom's decision: **include community-owned channels, clearly badged, with a stated inclusion bar** — and a community submission path (§12).

- **Inclusion bar (documented, applied at review):** active (not dormant/dead), reputable (recognizable community standing or substantive following), on-topic (SAP developer relevance), and safe (no policy-violating content).
- **Labeling:** `owner_type`-derived badges — "SAP", "SAP Advocate", "Community", "User Group", "Third-party". Community items never appear in `START_HERE`; they appear in `REFERENCE`/`TOOLS`/`KEEP_CURRENT`, the directory, and (if `REVIEWED`) topic bands.
- Individuals (advocates, community voices) are represented primarily via the existing Developer Advocates page and a compact "Community voices" collection, not as a sprawl of individual rows.

## 12. Community submission & moderation

- **Submit:** a lightweight form (add a channel / propose an edit / flag for removal) writing a `ChannelSubmissions` row. **Login-required (XSUAA)** by default to deter spam (see Open Questions).
- **Review:** a moderation queue in the admin shell — approve/reject with a note. Approve applies the change to `Channels` (ADD inserts, EDIT patches curated fields, REMOVE sets `isPublished=false`/`status`). Reject closes with a reason.
- Submissions never mutate `Channels` directly; every change is an auditable review action (reuses `managed` + reviewer fields).

## 13. Admin UI

New Fiori Elements components in the existing admin shell (matches `app/admin/shelf-definitions/`, `app/admin/homepage/`):

- **Channels** — browse/edit the source of truth; toggle `isPublished`/`isFeatured`; edit `editorialNote`, shelf/verb overrides.
- **Channel Collections** — CRUD collections + ordered items; edit intros/blurbs; flip `authoringStatus` to `REVIEWED`.
- **Channel Topic Map** — review/correct the crosswalk; promote `AI_SEEDED`→`REVIEWED`.
- **Channel Submissions** — moderation queue.

All under XSUAA, consistent with existing admin scopes.

## 14. Link health & lifecycle

- Reuse the nightly link-health pattern (`srv/jobs/homepage-link-health.js`) extended to `Channels.url`; `linkStatusOverride` silences false-BROKEN on auth/bot-gated URLs (same as shelves). `BROKEN` links are filtered from the directory/bands but retained in admin for triage.
- Retirement is soft (§6.5), honoring dataset correction notes.

## 15. Testing

- **Ingest:** unit tests on `seed-channels.cjs` — cite-marker stripping, enum normalization, idempotent re-run (unchanged hash skips; curated columns preserved), retire-on-absence. Run `cds deploy --to sqlite::memory:` before committing model changes; validate HANA-qualified names (avoid the unqualified-entity-name HANA trap noted in project memory).
- **Surface A:** shelf-promotion mapping tests; assert community items never land in `START_HERE`.
- **Surface B/C:** feed shape tests; facet filtering; crosswalk join renders only `REVIEWED` rows.
- **Submissions:** approve/reject applies/rejects correctly; anon-write is rejected (update any pre-existing anon-POST tests per the service-guard rule).
- **e2e:** a committed spec for `/channels` (advisory nudge; runs post-DEV-deploy).

## 16. Phasing

- **P0 — CEO overview report** ✅ *(delivered: `SAP-Developer-Channels-Overview.md`; feeds a leadership PowerPoint; independent of the build).*
- **P1 — Foundation + Surface A + directory core:** `Channels` entity + `seed-channels.cjs` ingest; `/channels` directory with facets + per-channel detail; fill verb shelves. Admin: Channels app.
- **P2 — Clustering & navigation:** `ChannelCollections` + LLM-seed/review; collections lead the directory landing. Admin: Collections app.
- **P3 — Per-topic bands (Surface C):** `ChannelTopicMap` + LLM-draft/review crosswalk; `/topics/*` + tutorial bands. Admin: Topic Map app.
- **P4 — Community submission loop:** `ChannelSubmissions` + submit form + moderation queue.

Each phase is independently shippable; P1 delivers standalone value.

## 17. Open questions

1. **Directory route placement:** top-level `/channels` (recommended) vs nested under a verb lane vs under `/explore/`.
2. **Submission access:** login-required (recommended, less spam) vs open with heavier moderation.
3. **Directory serving mechanism:** HANA-BLOB `page-channels` (matches Phase-2 content-page flip) vs Hugo page + island + live feed. Decide in P1 plan.
4. **`AI_SEEDED` visibility:** do we ever render un-reviewed collections/crosswalk rows behind a config flag, or hard-gate on `REVIEWED`?

## 18. Reused vs new

| Reused (existing) | New (this design) |
|---|---|
| `HomepageShelves` (`isExternal`, `badge=THIRD_PARTY`, `whyItMatters`, link-health, `AuthoringStatus`) | `Channels`, `ChannelCollections`(+items), `ChannelTopicMap`, `ChannelSubmissions` |
| `seed-*.cjs` convention | `scripts/seed-channels.cjs` |
| Admin shell + Fiori Elements pattern | 4 admin components |
| Nightly link-health job | Extended to `Channels.url` |
| `/topics/*` baked-data rendering | `channels_by_topic.json` + band partial |
