# Admin Joule Chat — Design

**Date:** 2026-05-19
**Status:** Draft (awaiting review)
**Related:** `2026-05-18-joule-chat-design.md` (the learner-side panel this builds on)

## Problem

The admin shell's toolbar `Joule` button currently calls `window.open('https://sap-samples.github.io/sap-devs-cli/')` ([app/admin-shell/webapp/controller/Shell.controller.js:118](../../../app/admin-shell/webapp/controller/Shell.controller.js#L118)). It should instead open the same Joule slide-out chat panel used on the Hugo learner site, but with a different persona — answering technical questions about the tutorial platform itself, aimed at tutorial authors and admins. The chat must be aware of the currently selected admin tool (and any drilled-in entity) and must be able to answer analytical questions about tutorial usage without ever leaking PII.

## Goals

1. Replace the toolbar button's behavior so it opens the chat panel.
2. Reuse the existing `/chat/stream` SSE backend; introduce a new `pageContext.kind === 'admin'` branch.
3. Give Joule three tools, conditionally exposed when `kind === 'admin'`:
   - `searchAdminDocs` — keyword search over a curated, build-time index of repo documentation.
   - `searchTutorials` — existing catalog search (still useful for admins).
   - `analyticsQuery` — structured query plan over an allowlisted analytics schema, with k=5 anonymity enforcement.
4. Surface the current admin route AND the currently drilled-in entity (id/type/title/slug) to the system prompt.
5. Never expose PII in any analytics result, regardless of how the LLM frames its query.

## Non-Goals (v1)

- Vector/embedding search over docs — keyword TF-weighted matching is enough for ~10 short docs.
- Indexing CDS schema files for `searchAdminDocs` — narrative docs cover what authors need.
- Analytics facts beyond completion and start (no prize/accomplishment surface in v1).
- Ratio measures, sparkline trends, CSV export from the chat.
- Custom admin chat UI styling — same look as the learner panel; the persona is the difference.
- Action-log buffer ("last admin action") — not requested.
- An in-panel settings cog — settings stay reachable via the left-nav (renamed "Joule Settings").

## Architecture Overview

```
Toolbar Joule btn → window.joule.open()        (admin-shell)
                                                          ↓
                                         ┌─────── joule.js (vendored from /js/joule.js, served via approuter) ───┐
                                         │  reads pageContext: { kind:'admin', tool, toolTitle, entity? }        │
                                         │  POST /chat/stream                                                   │
                                         └──────────────────┬───────────────────────────────────────────────────┘
                                                            ↓
                                        srv/server.js  (auth + ChatSettings + rate-limit)
                                                            ↓
                          buildSystemPrompt(pageContext, user)   ←  chat-context.js (NEW: ADMIN_PERSONA + adminLayer)
                                                            ↓
                          streamChat(... tools=[searchTutorials, searchAdminDocs, analyticsQuery])
                                                            ↓
                                  ┌──────────────────┬──────────────────────┐
                                  ↓                  ↓                      ↓
                         searchTutorials    searchAdminDocs        analyticsQuery
                         (existing)         (NEW: in-memory        (NEW: plan validator
                                             keyword index)         + CQL builder
                                                                    + k-anon filter)
```

The admin shell is XSUAA-protected and same-origin with the srv backend, so reusing `/chat/stream` requires no new auth plumbing. The approuter already routes `/chat/(.*)`, `/css/joule.css`, `/js/joule.js`, `/js/joule-render.js`.

## Components & Files

### Backend (`srv/`)

#### `srv/lib/chat-context.js` (modify)

Add a new persona constant and an admin layer. Existing PERSONA / tutorialLayer / searchLayer / collectionLayer / userLayer remain unchanged.

```js
const ADMIN_PERSONA = `You are Joule, an AI assistant embedded in the SAP
Tutorial Platform Admin Console. Your audience is tutorial AUTHORS and
PLATFORM ADMINS — people who build, publish, and operate the tutorial system
itself, not learners.

For "how does X work" questions about THIS system, call \`searchAdminDocs\`
first to ground your answer in the repository documentation. Cite the doc
path. If \`searchAdminDocs\` returns nothing relevant, say you don't have a
documented answer rather than inventing behavior or file paths.

For catalog questions (find a tutorial / mission / group), use
\`searchTutorials\`.

For analytical questions about tutorial usage, call \`analyticsQuery\` with a
structured plan. Allowed facts: completion, start. Allowed dimensions:
taskType, event, tag, mission, tutorial, group, completionMonth,
completionWeek. Allowed measures: count, distinctUsers. Date filters use
\`sinceDays\` or \`between\`. The system enforces k-anonymity (cells with
fewer than 5 distinct users are suppressed) and never exposes user identity.
If a question cannot be expressed within this schema, say so plainly rather
than guessing.

Never include credentials, API keys, or production URLs in responses.`;

function adminLayer(ctx) {
  const lines = [];
  if (ctx.tool) {
    const title = ctx.toolTitle || ctx.tool;
    lines.push(`Current admin tool: "${title}" (route key: ${ctx.tool}).`);
  } else {
    lines.push('Current admin tool: dashboard (no specific tool selected).');
  }
  if (ctx.entity?.id) {
    const e = ctx.entity;
    const parts = [`type: ${e.type || 'unknown'}`, `id: ${e.id}`];
    if (e.slug) parts.push(`slug: ${e.slug}`);
    const title = e.title ? ` "${e.title}"` : '';
    lines.push(`Currently editing: ${e.type || 'entity'}${title} (${parts.join(', ')}).`);
  }
  return lines.join('\n');
}

// pageLayer switch — add: case 'admin': return adminLayer(pageContext);
```

`buildSystemPrompt` selects between PERSONA (learner) and ADMIN_PERSONA based on `pageContext.kind`:

```js
export function buildSystemPrompt(pageContext, user) {
  const persona = pageContext?.kind === 'admin' ? ADMIN_PERSONA : PERSONA;
  return [persona, pageLayer(pageContext), userLayer(user)].filter(Boolean).join('\n\n');
}
```

#### `srv/lib/admin-docs-index.js` (new)

Runtime loader for the curated doc index. Lazy-loads JSON on first request, caches in module scope.

```js
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_PATH = join(HERE, '..', 'data', 'admin-docs-index.json');

let cached = null;

async function loadIndex() {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(INDEX_PATH, 'utf8'));
  } catch {
    cached = { version: 1, sections: [] };
  }
  return cached;
}

const STOPWORDS = new Set(['the','a','an','of','in','to','for','and','or','is','are','how','what','why']);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s/.-]/g, ' ')
    .split(/\s+/)
    .filter(t => t && !STOPWORDS.has(t) && t.length > 1);
}

export async function searchAdminDocs(query, topK = 3) {
  const idx = await loadIndex();
  if (!idx.sections.length) return [];
  const qTokens = new Set(tokenize(query));
  if (!qTokens.size) return [];

  const scored = idx.sections.map(sec => {
    const headingTokens = new Set(tokenize(sec.heading));
    const bodyTokens = tokenize(sec.content);
    const bodyCount = bodyTokens.reduce((a, t) => a + (qTokens.has(t) ? 1 : 0), 0);
    let headingMatch = 0;
    for (const t of qTokens) if (headingTokens.has(t)) headingMatch++;
    const score = headingMatch * 5 + bodyCount;
    return { sec, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.filter(s => s.score > 0).slice(0, topK);
  return top.map(({ sec }) => ({
    path: sec.path,
    heading: sec.heading,
    snippet: sec.content.slice(0, 600)
  }));
}
```

#### `srv/data/admin-docs-index.json` (build artifact)

Generated by `scripts/build-admin-docs-index.ts`. Gitignored. Shape:

```json
{
  "version": 1,
  "generatedAt": "2026-05-19T15:00:00Z",
  "sections": [
    {
      "path": "docs/content-pipeline.md",
      "heading": "Build pipeline",
      "headingPath": ["Content Pipeline", "Build pipeline"],
      "content": "..."
    }
  ]
}
```

#### `srv/lib/admin-analytics-schema.js` (new)

Declarative allowlist for the analytics tool. NOT directly exposed to the LLM — only its keys are referenced in the persona/tool description.

```js
export const ANALYTICS_SCHEMA = {
  facts: {
    completion: { source: 'TaskRecords', baseFilter: { status: 'COMPLETED' } },
    start:      { source: 'TaskRecords', baseFilter: {} }
  },
  dimensions: {
    taskType:        { kind: 'column', column: 'taskType' },
    event:           { kind: 'assoc',  path: 'event.title' },
    tag:             { kind: 'tag-multi-source' },     // requires per-taskType join
    mission:         { kind: 'task-lookup', taskType: 'MISSION', display: 'slug' },
    tutorial:        { kind: 'task-lookup', taskType: 'TUTORIAL', display: 'slug' },
    group:           { kind: 'task-lookup', taskType: 'GROUP',    display: 'title' },
    completionMonth: { kind: 'date-trunc', column: 'completionDate', unit: 'month' },
    completionWeek:  { kind: 'date-trunc', column: 'completionDate', unit: 'week' }
  },
  // CQL expression fragments — translated by the runner into cds.ql column refs.
  // NEVER raw SQL strings (per CLAUDE.md "never write raw SQL").
  measures: {
    count:         { cql: { func: 'count', args: ['*'] } },
    distinctUsers: { cql: { func: 'count', args: [{ ref: ['user_ID'] }], distinct: true } }
  },
  filterOps: {
    equals:    { kinds: ['column','assoc','task-lookup'] },
    contains:  { kinds: ['column','assoc','tag-multi-source'] },
    in:        { kinds: ['column','assoc','task-lookup'] },
    sinceDays: { kinds: ['date-trunc'], appliesTo: 'completionDate' },
    between:   { kinds: ['date-trunc'], appliesTo: 'completionDate' }
  },
  // Hard denylist — never appears in any SELECT or WHERE, regardless of schema state.
  pii_denylist: [
    'user', 'user_ID', 'email', 'givenName', 'familyName',
    'accountNumber', 'titleSnapshot', 'progressNote',
    'submissionIdStarted', 'submissionIdCompleted'
  ],
  K_ANON_MIN: 5,
  MAX_LIMIT: 100
};
```

#### `srv/lib/admin-analytics-runner.js` (new)

```js
// runAnalyticsQuery(plan): returns { columns, rows, suppressedCount, totalRows }
// or { error, reason } on validation failure.
//
// Steps:
// 1. validatePlan(plan)        — shape + allowlist check; reject anything unknown
// 2. buildCQL(plan)            — composes cds.ql SELECT(s); never raw SQL strings
//                                ALWAYS injects distinctUsers in selection
// 3. await cds.run(query)      — runs in current request context, no new conn
// 4. applyKAnon(rows, plan)    — see rules below
// 5. stripDistinctUsersIfNotRequested(rows, plan)
// 6. buildAuditEntry(plan, in, out, suppressed)  — see Audit logging below
```

Validation rejects (with explicit reason codes):
- Unknown `fact`, dimension, measure, or filter op → `unknown_field`.
- A field name not present in `dimensions` or `measures` → `unknown_field`.
- Any PII field appearing in `groupBy`, `filters[].field`, or implicitly via a dimension definition → `pii_denied`. Denylist is checked at every emission point, not just SELECT.
- `filters[].value` type mismatch per op → `invalid_value`:
  - `equals`, `contains`, `sinceDays`: value MUST be a string or finite number (no objects, no arrays).
  - `in`: value MUST be a non-empty array of strings/numbers.
  - `between`: value MUST be `[start, end]` — two-element array of comparable primitives.
- `sinceDays` value not in `[1, 3650]` → `invalid_value`.
- `limit > MAX_LIMIT` → silently capped to `MAX_LIMIT` (not rejected).

CQL building — special cases:
- All queries use `cds.ql` (`SELECT.from(...).columns(...).where(...)`); the runner translates `measures[].cql` and `dimensions[].kind` into CQL column refs and function expressions. **No raw SQL strings ever leave the runner.**
- `tag` dimension/filter — CQL has limited UNION support, so the runner issues **three separate `SELECT.from(TutorialTags|MissionTags|GroupTags).columns(...)` queries** and merges results in JS, re-aggregating by `(tag, ...other groupBy)` after merge.
- `mission`/`tutorial`/`group` dimensions JOIN against the corresponding entity by `taskLegacyId` filtered to the right `taskType` (also via `cds.ql`).
- `date-trunc` dimensions (`completionMonth`, `completionWeek`) emit a CQL function call (`{ func: 'to_varchar', args: [...] }` + truncation), NOT a raw SQL fragment. The runner picks the dialect-appropriate function via `cds.db.kind`.
- `sinceDays: N` produces `completionDate >= now - N days` as a CQL `where` predicate using `{ func: 'add_days', args: [...] }` or equivalent date arithmetic — again, no raw SQL.
- `count(distinct user_ID)` always present in SELECT (used by k-anon).

#### k-anonymity — exact rules

The runner applies k-anon AFTER the query runs and BEFORE returning rows:

1. **Grouped queries (`groupBy.length > 0`)** — drop every result row where `distinctUsers < K_ANON_MIN`. Increment `suppressedCount` per dropped row.
2. **Ungrouped queries (`groupBy` empty or omitted)** — the result is a single aggregate row. If its `distinctUsers < K_ANON_MIN`, return `{ columns, rows: [], suppressedCount: 1, totalRows: 1 }`. The LLM gets nothing to compose around individuals.
3. **Whole-population safeguard** — even when no `groupBy` is supplied, `count(distinct user_ID)` is always SELECTed and checked. There is no path that bypasses k=5.
4. **Strip after check** — `distinctUsers` is removed from final rows unless the LLM explicitly listed it in `measures`.

#### Server-side admin scope check

`pageContext.kind` from the client is **untrusted**. Before `toolsForContext` returns the admin tool list, the chat handler MUST verify the caller has the admin scope:

```js
const isAdmin = req.user?.is?.('admin');           // CAP user check
const effectiveKind = isAdmin ? pageContext?.kind : 'learner';
const tools = toolsForContext({ kind: effectiveKind });
```

If a learner forges `kind:'admin'` in the request body, `analyticsQuery` and `searchAdminDocs` are simply not registered with the LLM for that turn. The persona also falls back to the learner PERSONA. This makes scope enforcement layered, not just a UI-side flag.

#### Audit logging

Every `analyticsQuery` invocation logs an entry via `cds.log('chat')` containing: timestamp, user ID hash (sha256 of the CAP user id, NOT the raw id), request hash, `fact`, `dimensions`, `filters` (without their values — values may include free-text `contains` searches), `totalRows`, `suppressedCount`, and execution duration. Suppressed rows are NEVER logged. Result rows are NEVER logged. The audit serves operations triage, not analytics replay.

#### `srv/lib/chat-orchestrator.js` (modify)

Two new tool declarations:

```js
const SEARCH_ADMIN_DOCS_TOOL = {
  type: 'function',
  function: {
    name: 'searchAdminDocs',
    description: 'Search the SAP Tutorial Platform documentation (admin/architecture only). Use to ground answers about how the system works.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    }
  }
};

const DIMENSION_NAMES = [
  'taskType','event','tag','mission','tutorial','group',
  'completionMonth','completionWeek'
];

const FILTERABLE_FIELDS = [...DIMENSION_NAMES, 'completionDate'];

const ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'analyticsQuery',
    description: 'Run a structured analytics query over tutorial usage data. Returns aggregated rows; user identity is never exposed. K-anonymity (k=5) is enforced server-side.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string', enum: ['completion','start'] },
        measures: {
          type: 'array',
          items: { type: 'string', enum: ['count','distinctUsers'] },
          minItems: 1
        },
        groupBy: {
          type: 'array',
          items: { type: 'string', enum: DIMENSION_NAMES }
        },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: FILTERABLE_FIELDS },
              op: { type: 'string', enum: ['equals','contains','in','sinceDays','between'] },
              value: {
                description: 'equals/contains: string or number. in: non-empty array of strings/numbers. sinceDays: positive integer (1..3650). between: [start, end] two-element array of strings or numbers.'
              }
            },
            required: ['field','op','value']
          }
        },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: ['fact','measures']
    }
  }
};
```

`streamChat` accepts a new `tools` parameter list. The dispatcher:

```js
function toolsForContext(pageContext) {
  if (pageContext?.kind === 'admin') {
    return [SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL];
  }
  return [SEARCH_TUTORIALS_TOOL];
}

async function dispatchTool(name, args) {
  if (name === 'searchTutorials') return /* existing */;
  if (name === 'searchAdminDocs') return await searchAdminDocs(args.query);
  if (name === 'analyticsQuery')  return await runAnalyticsQuery(args);
  return { error: 'unknown_tool' };
}
```

**Important:** `toolsForContext` is called by `srv/server.js` AFTER the admin scope check (above) — never directly with the client-supplied `pageContext.kind`. A learner whose request body claims `kind:'admin'` gets the learner tool list and the learner persona.

After a successful `searchAdminDocs` call, stream `{ type: 'doc-citations', items }`. After `analyticsQuery`, stream `{ type: 'analytics-result', columns, rows, suppressedCount, totalRows }`.

#### `srv/server.js` (modify)

Pass `pageContext` to `streamChat` so it can pick the right tool list. (Today it only passes `system`; the orchestrator already receives messages but not pageContext directly.) Trivial threading change.

### Build (`scripts/`, `package.json`)

#### `scripts/build-admin-docs-index.ts` (new)

```ts
const SOURCES = [
  'CLAUDE.md',
  'docs/content-pipeline.md',
  'docs/authentication-primer.md',
  'docs/authentication-architecture.md',
  'docs/ias-migration-setup.md',
  'docs/ims-api-reference.md',
  'docs/ims-uncovered-features.md',
  'docs/hugo-migration.md',
  'docs/mta-deployment.md'
];

// For each: read → split by H2 / H3 markdown headings → emit { path, heading, headingPath, content } sections.
// Output → srv/data/admin-docs-index.json
```

#### `package.json` (modify)

Add:
```json
{
  "scripts": {
    "build:admin-docs": "tsx scripts/build-admin-docs-index.ts",
    "predev": "test -f srv/data/admin-docs-index.json || npm run build:admin-docs",
    "prewatch": "test -f srv/data/admin-docs-index.json || npm run build:admin-docs",
    "build:all": "npm run fetch-tutorials && npm run build:css && npm run build:apps && npm run build:hugo && npm run build:highlight && npm run build:display && npm run build:admin-docs"
  }
}
```

The `predev`/`prewatch` hooks ensure a fresh `cds watch` after a clean clone always has an index file present (even if empty), so `searchAdminDocs` falls back gracefully rather than returning a confusing first-run error.

#### `.gitignore` (modify)

Add `srv/data/admin-docs-index.json` (build artifact; regenerated on demand by `predev`/`prewatch`/`build:all`).

### Frontend (`app/admin-shell/`, `hugo/static/js/joule.js`)

#### `hugo/static/js/joule.js` (modify — minimal refactor)

- Make `#joule-trigger` lookup tolerant: if missing, skip auto-bind (don't `return` from the IIFE).
- **Attach `window.joule` synchronously, early** — at the top of the IIFE, before `loadConfig()` runs:
  ```js
  let _ready = false;
  let _pendingOpen = false;
  window.joule = {
    open: () => { if (_ready) open(); else { _pendingOpen = true; } },
    close: () => { if (_ready) close(); }
  };
  ```
  After `loadConfig().then(cfg => { ... })` resolves and `cfg.enabled` is true, set `_ready = true` and replay `_pendingOpen`. If disabled, `_pendingOpen` is dropped silently. This guarantees `onJoulePress` from the admin shell never races against script load — a fast click queues until ready.
- Extend `readPageContext()`:
  ```js
  if (ctx.kind === 'admin') {
    ctx.tool = html.dataset.adminTool || undefined;
    ctx.toolTitle = html.dataset.adminToolTitle || undefined;
    if (html.dataset.adminEntityId) {
      ctx.entity = {
        id: html.dataset.adminEntityId,
        type: html.dataset.adminEntityType || undefined,
        title: html.dataset.adminEntityTitle || undefined,
        slug: html.dataset.adminEntitySlug || undefined
      };
    }
  }
  ```
- Handle two new SSE event types:
  - `doc-citations` → render small inline citation chips below the active assistant bubble.
  - `analytics-result` → render an HTML `<table>` (capped at 100 rows). Headers from `columns`; rows from `rows`. Footer line: `N row(s) suppressed for privacy` if `suppressedCount > 0`.

This is a small additive change to the learner code — no behavior change when `kind !== 'admin'`.

#### `app/admin-shell/webapp/index.html` (modify)

Add inside `<head>`:
```html
<link rel="stylesheet" href="/css/joule.css">
```

Add at end of `<body>`:
```html
{{ joule-panel HTML, copied verbatim from hugo/layouts/partials/joule-panel.html }}
<script id="joule-starters" type="application/json">{
  "admin": [
    "How does the content publishing pipeline work?",
    "Show me completions for tags containing ABAP in the last 6 months.",
    "Why might a mission slug be missing?"
  ]
}</script>
<script src="/js/joule-render.js"></script>
<script src="/js/joule.js"></script>
```

Set `<html data-page-kind="admin">` (root).

#### `app/admin-shell/webapp/controller/Shell.controller.js` (modify)

```js
onJoulePress: function () {
  // window.joule is attached synchronously by joule.js (queues the open if not ready).
  // If joule.js failed to load entirely, fall back to a toast.
  if (window.joule && typeof window.joule.open === 'function') {
    window.joule.open();
  } else {
    sap.m.MessageToast.show("Joule is not available.");
  }
},

// In onInit, add:
this._wireAdminContextToHtml();

_wireAdminContextToHtml: function () {
  // Update <html data-admin-tool> on every route match
  this.getOwnerComponent().getRouter().attachRouteMatched((evt) => {
    const name = evt.getParameter('name');
    document.documentElement.dataset.adminTool = name;
    document.documentElement.dataset.adminToolTitle = NAV_KEY_TO_TITLE[name] || name;
  }, this);

  // Update <html data-admin-entity-*> on hash changes that include an OData key,
  // including composite/draft keys like "missions&/Missions(ID=uuid,IsActiveEntity=true)".
  HashChanger.getInstance().attachEvent('hashChanged', (evt) => {
    const hash = evt.getParameter('newHash') || '';
    const m = hash.match(/[&/]([A-Z][A-Za-z]+)\(([^)]+)\)/);
    const ds = document.documentElement.dataset;
    if (m) {
      ds.adminEntityType = m[1];
      ds.adminEntityId = parseODataKey(m[2]);
    } else {
      delete ds.adminEntityType;
      delete ds.adminEntityId;
      delete ds.adminEntityTitle;
      delete ds.adminEntitySlug;
    }
  }, this);
},

// Parse an OData key segment. Handles three shapes:
//   "uuid"                                  → "uuid"
//   "'value'" or '"value"'                  → "value"
//   "ID=uuid,IsActiveEntity=true"           → "uuid"  (prefer ID=, else first kv pair)
function parseODataKey(seg) {
  if (!seg.includes('=')) {
    return seg.replace(/^['"]|['"]$/g, '');
  }
  const pairs = seg.split(',').map(p => p.trim());
  const idPair = pairs.find(p => /^ID=/i.test(p)) || pairs[0];
  const value = idPair.split('=', 2)[1] || '';
  return value.replace(/^['"]|['"]$/g, '');
}
```

A follow-up enhancement (not v1): subscribe each Fiori Elements component's binding-context-change to populate `data-admin-entity-title` and `data-admin-entity-slug`. For v1, type+id are enough — the LLM can match against analytics results without title/slug.

#### `app/admin-shell/webapp/view/Shell.view.xml` and `controller/Shell.controller.js` (modify — rename only)

```xml
<tnt:NavigationListItem text="Joule Settings" key="joule" />
```
```js
joule: "Joule Settings"   // in NAV_KEY_TO_TITLE
```

### Approuter (`approuter/xs-app.json`)

No changes. `/chat/(.*)`, `/css/joule.css`, `/js/joule.js`, `/js/joule-render.js` already routed.

## Data Flow Examples

### Doc question

```
Admin: "How does delta publishing work?"
  → POST /chat/stream { messages, pageContext: { kind: 'admin', tool: 'tutorials', toolTitle: 'Tutorials' } }
  → System prompt: ADMIN_PERSONA + adminLayer + userLayer
  → LLM tool call: searchAdminDocs({ query: "delta publishing content" })
  → Runner returns 3 sections from docs/content-pipeline.md
  → SSE { type: 'doc-citations', items: [...] }
  → LLM follow-up turn produces prose answer citing docs/content-pipeline.md
  → SSE { type: 'done' }
```

### Analytics question (the example you asked about)

```
Admin: "How many completions for tags containing ABAP in the last 6 months?"
  → LLM tool call: analyticsQuery({
       fact: 'completion',
       measures: ['count'],
       filters: [
         { field: 'tag', op: 'contains', value: 'ABAP' },
         { field: 'completionDate', op: 'sinceDays', value: 180 }
       ],
       groupBy: ['tag']
     })
  → Runner: validate → build CQL across TutorialTags ∪ MissionTags ∪ GroupTags
            → execute → drop cells with distinctUsers < 5
  → Result: [{ tag: 'abap-cloud', count: 142 }, { tag: 'abap-rap', count: 87 }, ...]
  → SSE { type: 'analytics-result', columns:['tag','count'], rows:[…], suppressedCount: 2 }
  → Panel renders HTML table; LLM produces prose summary
  → SSE { type: 'done' }
```

### Drilled-in entity context

```
Admin navigates to Missions list → admin-shell sets data-admin-tool="missions"
Admin clicks Mission row → hash becomes "missions&/Missions(uuid-1234)"
                        → data-admin-entity-type="Missions", data-admin-entity-id="uuid-1234"
Admin opens Joule, asks: "Why might my slug be missing?"
  → System prompt includes: 'Currently editing: Missions (id: uuid-1234)'
  → LLM responds with grounded help (likely calls searchAdminDocs for slug-population docs)
```

## PII Defense — Four Layers

1. **Plan validation** — only allowlisted dimensions/measures/filter ops accepted. PII fields are not in the allowlist at all.
2. **Hard column denylist** — applied at SQL emission time. Even if a future schema edit accidentally allowlists a PII column, the runner strips it.
3. **k-anonymity (k=5)** — every grouped result row internally carries `count(distinct user_ID)`; rows with `< 5` are dropped. Suppressed count reported in aggregate, never per cell.
4. **Persona reinforcement** — system prompt instructs Joule to never request user-level data. Defense in depth, not the primary control.

## Error Handling

| Failure | Behavior |
|---|---|
| `ChatSettings.enabled === false` | Toolbar button hidden (existing 503 from `/api/ChatConfig` cached for 60s). Left-nav "Joule Settings" still works → admin can re-enable. |
| `admin-docs-index.json` missing | `searchAdminDocs` returns `[]`; LLM acknowledges it has no documented answer. |
| Plan validation fails | `analyticsQuery` returns `{ error: 'invalid_plan', reason }` → LLM apologizes / asks for clarification. |
| CQL execution error | Caught in runner → `{ error: 'query_failed' }` → LLM apologizes. Stack stays in server log. |
| All cells suppressed by k-anon | Returns `{ rows: [], suppressedCount: N, totalRows: 0 }` → LLM says "not enough data to share without compromising privacy". |
| Auth missing | Existing 401 path → panel redirects to login. |
| Rate limit hit | Existing 429 path → "You've reached today's chat limit." |

## Testing

### Unit (vitest, in-memory SQLite)

| File | Coverage |
|---|---|
| `srv/lib/__tests__/chat-context.admin.test.js` | `buildSystemPrompt({kind:'admin', tool:'missions'})` includes ADMIN_PERSONA + tool layer. With `entity` populated, includes "Currently editing" line. |
| `srv/lib/__tests__/admin-docs-index.test.js` | Index a fixture markdown file; search "publishing" returns top section with heading "Publishing"; empty query returns `[]`; missing index file falls back to `[]`. |
| `srv/lib/__tests__/admin-analytics-runner.test.js` | Cases: (a) valid plan with groupBy returns expected rows; (b) PII column in `groupBy` rejected with `pii_denied`; (c) PII column in `filters[].field` rejected with `pii_denied`; (d) unknown dimension rejected with `unknown_field`; (e) `value` of wrong type per op rejected with `invalid_value` (object passed to `equals`, non-array passed to `in`, three-element array passed to `between`); (f) k-anon grouped: row with `distinctUsers=4` suppressed, `=5` kept, `suppressedCount` reflects count; (g) k-anon ungrouped: single-row result with `distinctUsers=4` returns `rows:[], suppressedCount:1, totalRows:1`; ungrouped with `distinctUsers=5` keeps the row; (h) `tag contains 'ABAP'` queries all three tag tables and merges; (i) `sinceDays:180` produces correct date predicate via cds.ql (no raw SQL string in serialised query); (j) rows over `MAX_LIMIT` capped; (k) `distinctUsers` stripped from rows when not in `measures`. |
| `srv/__tests__/tools-for-context.test.js` | When user lacks admin scope, `toolsForContext` returns learner tool list even if `pageContext.kind:'admin'` is supplied (forgery rejection). When user has admin scope and `kind:'admin'`, returns admin tool list. |

### Hybrid (real HANA)

| File | Coverage |
|---|---|
| `test/hybrid/admin-analytics.test.js` | One real analytics query (e.g., `fact:'completion', groupBy:['taskType']`) returns ≥0 rows; assert no PII columns present in result; assert `suppressedCount` field present. |

### Smoke (deployed)

| File | Coverage |
|---|---|
| `test/smoke/admin-joule.test.js` | `/chat/stream` POST with `kind:'admin'` returns SSE; first event is `delta` or `tool`; no PII in response stream. |

### Manual

- Open admin shell locally; click toolbar Joule; panel opens.
- Navigate to Missions → drill into a mission row → ask "What entity am I looking at?" → response references type=Missions, id=...
- Ask "How does delta publishing work?" → assistant cites `docs/content-pipeline.md`.
- Ask the ABAP-tags-6-months question → table renders with non-empty rows; no email/userId columns.
- Disable in Joule Settings → reload admin shell → toolbar Joule button hidden; left-nav "Joule Settings" still reachable.

## Build / Deploy

- `build:admin-docs` runs as part of `build:all` (CI) before `build:cds`. Output goes to `srv/data/admin-docs-index.json`.
- The JSON is bundled into the deployed CAP service via the existing `cds build` (which copies `srv/**`).
- No new MTA modules; no new service bindings.

## Open Risks / Mitigations

| Risk | Mitigation |
|---|---|
| LLM tries to bypass schema by stuffing SQL into a `value` field | Plan validator rejects any non-primitive `value` types per op; no `op:'raw'` exists. |
| Tag JOIN explodes for very common tags | `MAX_LIMIT=100` cap; query timeout from existing CAP HANA pool. |
| `searchAdminDocs` returns stale content after a docs change before next deploy | Acceptable — docs change cadence is low; rebuild index on each deploy. Could add a manual `/admin/rebuild-docs-index` endpoint as a follow-up. |
| Admin shell's panel CSS clashes with `sap_horizon` theme | Visual review during manual testing; if needed, add a small `joule-panel--admin` overrides file. |
| Drilled-in entity title/slug not surfaced in v1 | Type+id is enough for the LLM to recognize "the user is on entity X"; title/slug enhancement deferred. |

## Dependencies

No new npm packages. Reuses existing:
- `@sap-ai-sdk/orchestration` (already in use by `chat-orchestrator.js`).
- `@sap/cds` (CQL builder).
- `tsx` (build script runner).

## Rollout

Single deploy: build the index, ship the modified `chat-context.js` / `chat-orchestrator.js` / `joule.js` / `Shell.controller.js`. No data migration. No feature flag in v1 — falls back gracefully if `kind !== 'admin'` is sent (existing PERSONA used).

## Success Criteria

1. Toolbar Joule button opens the chat panel; left-nav says "Joule Settings".
2. `kind:'admin'` requests use the admin persona; non-admin requests are unchanged.
3. `searchAdminDocs` returns relevant sections from `docs/content-pipeline.md` for "delta publishing" query.
4. `analyticsQuery` answers the ABAP-tags-6-months question with grouped results, no PII columns, k-anon applied.
5. All existing learner-side tests still pass.
6. New unit tests pass; hybrid analytics test returns ≥0 rows with no PII.
