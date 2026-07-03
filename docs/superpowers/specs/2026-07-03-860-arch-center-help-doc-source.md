# Phase 4.7 addendum — SAP Architecture Center as a 4th help-doc source design spec

- **Status:** Draft (2026-07-03), pending spec-reviewer pass
- **Issue:** [#860](https://github.com/sap-tutorials/tutorials-ims/issues/860)
- **Parent spec:** [`2026-07-01-748-phase4.7-help-docs.md`](./2026-07-01-748-phase4.7-help-docs.md)
- **Type:** Additive extension to Phase 4.7 — no new phase, no new entity, no new predicate, no new sidebar section, no new resource type.

## 1. Summary

Add `architecture.learning.sap.com` (the SAP Architecture Center, source repo [`SAP/architecture-center`](https://github.com/SAP/architecture-center)) as the **fourth source** feeding the existing Phase 4.7 `HelpDocs` entity. Reference architectures, AI-golden-path guides, and North Star docs render as `help-doc` graph nodes with the `explains` predicate, exactly like the three sibling sources.

New source key: `'architecture-sap-com'`. Source label: `'Architecture Center'`. Source precedence: highest of the four (`4`) — the Architecture Center is the canonical home for reference-architecture guidance and should win any cross-source content-hash collision.

The change surface is intentionally narrow — one new fetcher module, six one-line touches in existing modules, three fixture files, one fetcher unit test, one dedupe unit test amendment, one docs-navigation update. No schema change. No new admin action. No new cron. Zero UI branches (Phase 4.7 sidebar/concept-page rendering is generic over `help-doc.source`; new labels appear automatically).

## 2. Scope

### In scope

- New fetcher: `srv/lib/help-docs/architecture-sap-com-fetcher.js`. Direct GitHub REST API against `SAP/architecture-center`, enumerating `docs/**/*.{md,mdx}` and `news/**/*.{md,mdx}` — mirrors `cap-cloud-sap-fetcher.js` (§4.2.3 of the parent spec) shape verbatim.
- Wire the fetcher into `srv/lib/help-docs/index.js`:
  - `Promise.allSettled` third-then-fourth branch
  - `SOURCE_PRECEDENCE['architecture-sap-com'] = 4` (highest)
  - `FETCHER_BY_SOURCE['architecture-sap-com'] = archSapCom`
  - `perSource['architecture-sap-com'] = shape(archRes)`
- Wire the source-label map:
  - `HELP_DOC_SOURCE_LABEL['architecture-sap-com'] = 'Architecture Center'` in `srv/lib/published-concepts-query.js`
- Extend `summary.perSource` init in `srv/jobs/fetch-help-docs-job.js` with the fourth key.
- Update the CDS comment enumerating source values in `srv/knowledge-graph-service.cds` (lines 119-120) and any doc comment that lists the three sources verbatim.
- Update `docs/developers/architecture/knowledge-graph.md` Phase 4.7 section to reflect four sources.
- Three test fixtures under `test/unit/srv/__fixtures__/`:
  - `arch-sap-com-tree.json` (GitHub tree fixture)
  - `arch-sap-com-ref-arch.md` (representative reference-architecture MDX page)
  - `arch-sap-com-news.md` (representative news post)
- One new unit test file: `test/unit/srv/architecture-sap-com-fetcher.test.js`
- Dedupe unit-test amendment in `test/unit/srv/help-docs-dedupe.test.js` — extend the precedence test to include `architecture-sap-com > cap-cloud-sap`.
- Orchestrator unit-test amendment in `test/unit/srv/help-docs-orchestrator.test.js` — extend "returns { rows, perSource } when all three fetchers succeed" to four sources.
- Cron job-test amendment in `test/unit/srv/fetch-help-docs-job.test.js` — extend summary shape assertion to expect the fourth `perSource` key.

### Out of scope

- New Phase 4.9 corpus with a distinct `reference-architecture` type. This addendum settles the "is a reference architecture a help doc?" question with **yes** for v1. A distinct type with diagram thumbnails and technology-partner facets is a plausible future spec but is NOT this issue.
- Rendering reference-architecture diagrams inline. External links open in a new tab (matches Phase 4.7 §6 Q12).
- Technology-partner facet filtering (AWS/Azure/GCP/Databricks/Snowflake/IBM/Nvidia). The GitHub markdown carries partner tags in frontmatter, but v1 does not expose them in the sidebar or the `/build/concepts` payload.
- News-post recency ranking. All four sources sort alphabetically by `title` within priority 70 (Phase 4.7 §4).
- Backfill script. The next scheduled `fetch-help-docs` cron pulls the new corpus. Operators who want it sooner can trigger via the existing admin Run-now button, or `seedHelpDocs()` action, or `scripts/seed-help-docs.cjs --commit` — all three paths pick up the fourth fetcher without code changes.

## 3. Architectural decisions

Five decisions specific to this addendum. Everything else defers to the parent spec.

| # | Decision | Rationale |
|---|---|---|
| Q1 | **Add as 4th source under Phase 4.7 rather than open Phase 4.9** | The Architecture Center's content shape (narrative reference documentation, page-level nodes, `explains` predicate, source label badge) is identical to the three Phase 4.7 sources. A new phase would require: new entity, new link table, new predicate, new resource type config, new sidebar branch, new concept-page section, new cron. All of that is dead-weight duplication for content that renders the same way. Add-a-source keeps the chassis symmetric. |
| Q2 | **Source key `'architecture-sap-com'`** | Mirrors the domain-derived convention (`help-sap-com`, `cap-cloud-sap`, `ui5-sap-com` are all `<host>-with-dashes`, subdomain-first). Reads clearly in logs and per-source metrics. |
| Q3 | **Source label `'Architecture Center'`** | Sidebar and concept-page rows show a compact human-readable badge. `'Arch Center'` was rejected as looking abbreviated; the full label fits within the badge width budget verified in Phase 4.7 §4.5 (`SAP Help` is 8 chars; `Architecture Center` is 19 — checked against the Vue sidebar's max badge width in `SidebarPanel.vue`). |
| Q4 | **Source precedence `4` (highest)** | The Architecture Center is the canonical home for reference-architecture and North Star guidance — content that also appears on `help.sap.com` or in `cap-js/docs` should defer to the Architecture Center's version when the content hash collides. Cross-source dedupe order becomes `architecture-sap-com > cap-cloud-sap > ui5-sap-com > help-sap-com`. |
| Q5 | **Scope: `docs/**/*.{md,mdx}` + `news/**/*.{md,mdx}`** | The GitHub repo's `docs/` folder contains the 245-URL documentation catalog (ref-arch, agent, golden-path, north-star-arch, community). The `news/` folder contains the news-section posts surfaced on the home page. `api/` (Docusaurus plugin internals) is excluded — it's meta-documentation for the site builder, not SAP architecture content. |

## 4. Architecture

### 4.1 Data model

No change. Rows land in the existing `com.sap.developers.ims.external.HelpDocs` entity with:
- `source = 'architecture-sap-com'`
- `product = 'architecture'` (a new product token — Phase 4.7 uses free-form product strings, no enum constraint at the DB layer)
- `section = null` (per Phase 4.7 §3 Q5 — page-level nodes; anchor is optional and set at extract time, not fetch time)

Slug format is unchanged: `hd-architecture-sap-com__<canonicalized-path>` (150-char cap). The `canonicalizeHelpDocPath()` helper in `srv/lib/help-docs/index.js` needs no modification — the `hd-<source>__<path>` template is source-agnostic.

### 4.2 Fetcher module

`srv/lib/help-docs/architecture-sap-com-fetcher.js` mirrors `cap-cloud-sap-fetcher.js`:

```
Endpoint layout:
  TREE_URL:  https://api.github.com/repos/SAP/architecture-center/git/trees/main?recursive=true
  RAW_BASE:  https://raw.githubusercontent.com/SAP/architecture-center/main
  SITE_BASE: https://architecture.learning.sap.com

Enumeration filter (post-tree):
  e.type === 'blob'
  && (e.path.startsWith('docs/') || e.path.startsWith('news/'))
  && (e.path.endsWith('.md') || e.path.endsWith('.mdx'))

Per-file:
  - Raw fetch via RAW_BASE
  - parseMarkdown (frontmatter + body); MDX and MD share the frontmatter grammar
  - Title precedence: frontmatter `title:` → first H1 → filename without extension
  - Description: stripMarkdown(body).slice(0, 2000)
  - Skip when description === ''
  - URL: derived from `sourceId` by:
      1. Strip the `.md` or `.mdx` suffix
      2. Prepend SITE_BASE with a `/`
    Example: `docs/ref-arch/RA0001.md` → `https://architecture.learning.sap.com/docs/ref-arch/RA0001`
  - product = 'architecture'
  - section = null

Row shape:
  {
    source: 'architecture-sap-com',
    sourceId: <blob.path>,           // e.g. 'docs/ref-arch/RA0001.md'
    title: <string>,
    description: <string, ≤2000 chars>,
    url: <string>,
    product: 'architecture',
    section: null,
  }

Error handling:
  - Tree-call failure → throw (matches cap-cloud-sap contract; orchestrator turns it into a per-source rejection).
  - Per-blob fetch failure → console.warn, continue to next blob (matches cap-cloud-sap; partial-catalog is a fetcher-level survivability property).

Auth:
  - GitHub token via caller's `apiKey`. Falls back to unauth (public repo, ~60/hr shared-IP quota). One tree call + N raw calls per cycle; N ≤ 245 currently, well within a single-cron budget when authenticated.
```

**stripMarkdown** must handle MDX-specific syntax. The parent spec's helper is:
```
.replace(/```[\s\S]*?```/g, ' ')          // fenced code blocks
.replace(/`[^`]*`/g, ' ')                  // inline code
.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')  // links → text
.replace(/[#>*_~`]/g, ' ')                 // markdown syntax
.replace(/\s+/g, ' ')
.trim()
```

Two additions for MDX:
```
.replace(/^import\s+[^\n]+\n/gm, ' ')      // MDX top-of-file imports
.replace(/<[A-Z][A-Za-z0-9]*[^>]*\/?>[\s\S]*?<\/[A-Z][A-Za-z0-9]*>|<[A-Z][A-Za-z0-9]*[^>]*\/>/g, ' ')  // JSX/MDX components
```

The two extras are prepended to the shared stripMarkdown pipeline. Both are safe on plain markdown (the regexes match syntax that never appears in `.md`) — we can reuse the same helper across all four sources.

**Refactor:** extract the shared markdown-stripping logic into a new module `srv/lib/help-docs/_strip-markdown.js` and re-import it from both `cap-cloud-sap-fetcher.js` and the new `architecture-sap-com-fetcher.js`. This keeps the two source implementations DRY and avoids diverging regex sets.

### 4.3 Orchestrator wiring

Six one-line touches in `srv/lib/help-docs/index.js`:

1. `import * as archSapCom from './architecture-sap-com-fetcher.js';`
2. `SOURCE_PRECEDENCE['architecture-sap-com'] = 4` (add first entry, highest priority)
3. `FETCHER_BY_SOURCE['architecture-sap-com'] = archSapCom`
4. Add fourth branch to `Promise.allSettled`
5. Add fourth `shape(archRes)` entry to `perSource`
6. Spread the fourth `rows` array into the final concat

`dedupeByContentHash` and `canonicalizeHelpDocPath` need no modification — both are source-agnostic.

### 4.4 Cron summary shape

One line touch in `srv/jobs/fetch-help-docs-job.js`:

```js
perSource: {
  'help-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'cap-cloud-sap': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'ui5-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },
  'architecture-sap-com': { rowsFetched: 0, fetcherRejected: false, reason: null },   // NEW
},
```

The rest of the cron logic is source-agnostic — the per-row loop (§5-15 of the parent spec) delegates to `canonicalizeHelpDocPath(row.source, row.sourceId)` and `HELP_DOC_SOURCE_LABEL[h.source]`, both of which pick up the fourth source automatically once its label is registered.

### 4.5 UI rendering

**Zero UI branches.** Both `SidebarPanel.vue` and `ExpandedPanel.vue` are data-driven since #850 (see `docs/developers/architecture/knowledge-graph.md` Phase 5 note). The concept-page section-#3 template in `hugo/layouts/concepts/single.html` iterates over `helpDocs[]` and renders `{sourceLabel}` — no per-source `v-if`.

Once `HELP_DOC_SOURCE_LABEL['architecture-sap-com'] = 'Architecture Center'` lands, rows appear in the sidebar and concept page with that badge, in alphabetical order by `source` within priority 70 (Phase 4.7 §3 Q14). The `renderMeta()` in `srv/lib/kg-resource-type-config.js` for the `help-doc` type is unchanged.

### 4.6 Cross-source dedupe

Precedence extends to a four-tier ladder: `architecture-sap-com (4) > cap-cloud-sap (3) > ui5-sap-com (2) > help-sap-com (1)`. Existing dedupe unit test (`test/unit/srv/help-docs-dedupe.test.js`) grows one case for the new top rank.

The dedupe function (`dedupeByContentHash` in `srv/lib/help-docs/index.js`) is precedence-agnostic — it reads `SOURCE_PRECEDENCE[row.source]` at compare time. No modification.

## 5. Testing

### 5.1 New unit test

`test/unit/srv/architecture-sap-com-fetcher.test.js` — four cases (mirrors the `cap-cloud-sap-fetcher.test.js` pattern):

1. **Enumerates `.md` and `.mdx` files under `docs/` and `news/`, skips others** (tree fixture with mixed extensions).
2. **Derives canonical URL from file path** (`docs/ref-arch/RA0001.md` → `https://architecture.learning.sap.com/docs/ref-arch/RA0001`; `.mdx` handled identically).
3. **Extracts title from frontmatter, falls back to H1, then filename** (three-input parameterized case).
4. **Strips MDX-specific syntax** (JSX components + `import` lines removed; description length ≤ 2000).

### 5.2 Amended existing unit tests

- `test/unit/srv/help-docs-orchestrator.test.js` — the four `_setMockFetcher` calls become five (add `'architecture-sap-com'`); the "all fetchers succeed" and "partial catalog" cases extend their `perSource` assertions to include the new key.
- `test/unit/srv/help-docs-dedupe.test.js` — add one test asserting that a same-content row from `architecture-sap-com` wins over `cap-cloud-sap`.
- `test/unit/srv/fetch-help-docs-job.test.js` — the summary-shape assertion grows one key.

### 5.3 Fixtures

- `test/unit/srv/__fixtures__/arch-sap-com-tree.json` — GitHub-tree shape with ~6 blobs mixing:
  - `docs/ref-arch/RA0001.md` (representative reference-architecture)
  - `docs/ref-arch/RA0002.mdx` (representative MDX ref-arch)
  - `docs/golden-path/ai-golden-path.md`
  - `docs/community/contribution.md`
  - `news/2026-06-agentic-code-quality.mdx`
  - `api/plugins/some-internal-page.md` — used only to verify the `docs/`+`news/` allow-list rejects it
- `test/unit/srv/__fixtures__/arch-sap-com-ref-arch.md` — an MD page with frontmatter `title:` + a code block + a link + a heading. ~1000 chars of body.
- `test/unit/srv/__fixtures__/arch-sap-com-news.md` — a news post with an MDX `import` and one JSX component, verifying the extended stripMarkdown handles it.

### 5.4 No new hybrid test

Phase 4.7's hybrid tests (`test/hybrid/help-docs-cron.test.js`, `test/hybrid/help-docs-schema.test.js`) exercise the cron end-to-end against real HANA. Since we're not changing the schema or the cron loop shape, the existing hybrid tests cover the fourth source once it lands via `dev` deploy. No new hybrid file.

### 5.5 No new smoke test

`test/smoke/concept-page-help-docs.test.js` and `test/smoke/explore-data-help-doc-nodes.test.js` are source-agnostic — they assert the `help-doc` type renders, not per-source counts. They pass unchanged post-deploy once at least one Architecture Center row lands in production.

## 6. Deployment

1. Merge PR — no schema change, no cron change, so a standard `deploy.yml` deploy suffices.
2. First `fetch-help-docs` cron run post-deploy (Wednesday 05:17 UTC per Phase 4.7 §8) picks up the fourth fetcher automatically.
3. Optional: trigger `seedHelpDocs()` from the admin UI to populate immediately.
4. Verify: `select count(*) from com_sap_developers_ims_external_HelpDocs where source = 'architecture-sap-com'` — expect >0 rows within one cycle.

## 7. Rollback

If the fetcher misbehaves, `_setMockOrchestrator` is a test-only seam and won't help in production. Production rollback is a code revert:

```bash
git revert <merge-sha>
```

Since the fetcher is additive and the orchestrator uses `Promise.allSettled`, a broken new fetcher **cannot break the other three sources** — its rejection surfaces as `perSource['architecture-sap-com'].fetcherRejected = true` in the cron summary log, and the cron continues with the other three catalogs.

## 8. Open questions

None. Every question resolved in the parent Phase 4.7 spec applies here transitively.
