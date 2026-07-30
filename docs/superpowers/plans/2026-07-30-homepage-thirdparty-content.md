# Homepage Third-Party Content Seed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 20 curated third-party content entries to the homepage verb sections, loadable into DEV only, saved as a git-tracked artifact that can be deliberately promoted to PROD later.

**Architecture:** A git-tracked staging JSON file (`db/data/staging/homepage-thirdparty.json`) that CAP does NOT auto-load, plus an idempotent Node loader (`scripts/seed-thirdparty.js`) that upserts the rows into the active-profile CAP `db` service on the `(verb, url)` natural key. Run the loader against DEV; PROD stays clean until manually promoted. A data-validation test guards the JSON contents with no DB required.

**Tech Stack:** Node 24 (ESM, `"type": "module"`), `@sap/cds` ^10, Vitest (`unit` project), CAP CQL (`SELECT`/`INSERT`/`UPDATE`).

## Global Constraints

- **No raw SQL** — use `cds.ql` (`SELECT`/`INSERT`/`UPDATE`) only. (CLAUDE.md hard constraint.)
- **No schema change** — do not touch `db/homepage.cds`. Reuse existing `THIRD_PARTY` badge enum.
- **Persona tags** must all be members of `KNOWN_TAGS` from `srv/lib/homepage/persona-tag-validator.js` (grammar `role:{developer,architect,sysadmin,student}`, `deployment:{cloud,onprem}`, `cloud:{btp,aws,azure,gcp,alibaba,oracle,ibm}`). Import the real validator — never duplicate the vocab.
- **Every entry:** `badge="THIRD_PARTY"`, `isExternal=true`, `isActive=true`, `authoringStatus="REVIEWED"`, `personaWeight=0`, `url` absolute https, `title`≤120, `description`≤280, `tagline`≤140, `whyItMatters`≤800.
- **Namespace:** CAP model namespace is `com.sap.developers.ims`; resolve entities via `cds.entities('com.sap.developers.ims')`.
- **ESM only** — `import`, not `require`. Files are `.js` (project is `"type": "module"`).
- **Staging dir is not auto-loaded:** the file MUST live under `db/data/staging/` (CAP only auto-loads `db/data/<namespace>-<Entity>.csv`, not subdirectories), so it never deploys implicitly to PROD.
- **Spec:** `docs/superpowers/specs/2026-07-30-homepage-thirdparty-content-design.md`.

---

### Task 1: Staging content file (20 entries) + data-validation test

**Files:**
- Create: `db/data/staging/homepage-thirdparty.json`
- Test: `scripts/__tests__/seed-thirdparty-data.test.js`

**Interfaces:**
- Produces: `db/data/staging/homepage-thirdparty.json` — a JSON array of entry objects, each with keys: `ID` (string), `verb` (string), `shelf` (string), `sortOrder` (int), `title` (string), `url` (string), `description` (string), `badge` (`"THIRD_PARTY"`), `isExternal` (`true`), `isActive` (`true`), `authoringStatus` (`"REVIEWED"`), `personaWeight` (`0`), `tagline` (string), `whyItMatters` (string), `personaTags` (string[]). Task 2's loader consumes this file.

- [ ] **Step 1: Write the staging JSON file**

Create `db/data/staging/homepage-thirdparty.json`. The first array element is a comment marker object documenting promotion (kept simple so `JSON.parse` still works — it is filtered out by the loader and test on `_comment`):

```json
[
  {
    "_comment": "HOW TO PROMOTE TO PROD: after review on DEV, either (a) append these rows to db/data/com.sap.developers.ims-HomepageShelves.csv and redeploy PROD, or (b) run `npm run seed:thirdparty` against the PROD cds profile. This file stays the source of truth. Rows loaded to DEV via `npm run seed:thirdparty`. See docs/superpowers/specs/2026-07-30-homepage-thirdparty-content-design.md"
  },
  {
    "ID": "66333900-3rd0-0002-0001-000000000001",
    "verb": "BUILD", "shelf": "TOOLS", "sortOrder": 200,
    "title": "Vercel",
    "url": "https://vercel.com",
    "description": "Frontend cloud for building and deploying React, Vue, and static sites with global edge delivery.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Deploy React and Vue frontends to a global edge in minutes.",
    "whyItMatters": "CAP treats React and Vue as first-class frontends. Vercel is a common host for those SPAs, giving developers preview deployments, edge functions, and CI-driven releases that pair well with a CAP backend on BTP.",
    "personaTags": ["role:developer", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000001",
    "verb": "MODEL", "shelf": "REFERENCE", "sortOrder": 200,
    "title": "Dremio",
    "url": "https://www.dremio.com",
    "description": "Lakehouse platform for SQL analytics directly on data lake storage, built around Apache Iceberg.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Query your data lake with SQL — no copies, no cubes.",
    "whyItMatters": "Dremio is a leading open lakehouse engine. For teams federating SAP data with lake storage, it is a practical reference for Iceberg-based analytics alongside SAP Datasphere and Business Data Cloud.",
    "personaTags": ["role:developer", "role:architect", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000002",
    "verb": "MODEL", "shelf": "KEEP_CURRENT", "sortOrder": 210,
    "title": "Dremio Community",
    "url": "https://community.dremio.com",
    "description": "Community forum for Dremio users — Q&A, how-tos, and release discussion.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Ask questions and share patterns with other Dremio users.",
    "whyItMatters": "The Dremio community forum is where lakehouse practitioners troubleshoot Iceberg, reflections, and federation — useful when integrating lake data with SAP analytics.",
    "personaTags": ["role:developer", "role:architect"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000003",
    "verb": "MODEL", "shelf": "REFERENCE", "sortOrder": 220,
    "title": "Apache Iceberg",
    "url": "https://iceberg.apache.org",
    "description": "Open table format for huge analytic datasets — the storage standard behind modern lakehouses.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "The open table format underpinning modern lakehouses.",
    "whyItMatters": "Iceberg is the table format SAP Business Data Cloud and many lake engines build on. Understanding it helps architects reason about how SAP and non-SAP data interoperate at the storage layer.",
    "personaTags": ["role:developer", "role:architect", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000004",
    "verb": "MODEL", "shelf": "KEEP_CURRENT", "sortOrder": 230,
    "title": "Data Engineering Weekly",
    "url": "https://www.dataengineeringweekly.com",
    "description": "Curated weekly newsletter on data engineering trends, tools, and architecture.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Stay current on the wider data-engineering ecosystem.",
    "whyItMatters": "A concise weekly read that keeps data architects aware of trends beyond the SAP stack — pipelines, formats, and platform shifts that influence integration choices.",
    "personaTags": ["role:architect"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000005",
    "verb": "MODEL", "shelf": "KEEP_CURRENT", "sortOrder": 240,
    "title": "The Data Stack Show",
    "url": "https://datastackshow.com",
    "description": "Podcast with data engineers and founders on how modern data stacks are built and run.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Conversations on how real data stacks get built.",
    "whyItMatters": "Practitioner interviews that surface the tradeoffs behind modern data platforms — helpful context for teams positioning SAP data products within a broader stack.",
    "personaTags": ["role:developer", "role:architect"]
  },
  {
    "ID": "66333900-3rd0-1029-0001-000000000006",
    "verb": "MODEL", "shelf": "KEEP_CURRENT", "sortOrder": 250,
    "title": "Reltio Community",
    "url": "https://community.reltio.com",
    "description": "Community for Reltio master-data-management practitioners — Q&A and best practices.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Master-data-management practices from the Reltio community.",
    "whyItMatters": "MDM is a frequent companion to SAP data landscapes. The Reltio community is a reference point for entity resolution and data-quality patterns that complement SAP master data.",
    "personaTags": ["role:developer", "role:architect"]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000001",
    "verb": "AI", "shelf": "REFERENCE", "sortOrder": 200,
    "title": "Hugging Face",
    "url": "https://huggingface.co",
    "description": "Hub for open models, datasets, and ML tooling — the de facto registry for the AI ecosystem.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "The open hub for models, datasets, and ML tooling.",
    "whyItMatters": "Hugging Face is where most open models and datasets live. Developers building AI on BTP often source or evaluate models here before deploying via SAP AI Core.",
    "personaTags": ["role:developer", "role:student", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000002",
    "verb": "AI", "shelf": "TOOLS", "sortOrder": 210,
    "title": "TabPFN (Prior Labs)",
    "url": "https://github.com/PriorLabs/TabPFN",
    "description": "Foundation model for tabular data that delivers strong results on small datasets without training.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "A foundation model for tabular data — no training required.",
    "whyItMatters": "Most enterprise data is tabular. TabPFN is a notable open model for tabular prediction, relevant to developers exploring ML on structured SAP data.",
    "personaTags": ["role:developer", "role:student"]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000003",
    "verb": "AI", "shelf": "REFERENCE", "sortOrder": 220,
    "title": "Prior Labs Research",
    "url": "https://priorlabs.ai/research",
    "description": "Research and technical reports behind TabPFN and tabular foundation models.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "The research behind tabular foundation models.",
    "whyItMatters": "Prior Labs publishes the papers and reports underpinning TabPFN, including work featured in Nature — a primary source for developers evaluating the approach.",
    "personaTags": ["role:developer", "role:student"]
  },
  {
    "ID": "66333900-3rd0-0005-0001-000000000004",
    "verb": "AI", "shelf": "TOOLS", "sortOrder": 230,
    "title": "Kaggle",
    "url": "https://www.kaggle.com",
    "description": "Platform for datasets, notebooks, and ML competitions with a large practitioner community.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Datasets, notebooks, and competitions to sharpen ML skills.",
    "whyItMatters": "Kaggle is a practical training ground for data science. Its datasets and notebooks help developers and students build the ML skills they later apply on SAP data.",
    "personaTags": ["role:developer", "role:student"]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000001",
    "verb": "INTEGRATE", "shelf": "KEEP_CURRENT", "sortOrder": 200,
    "title": "n8n Community Forum",
    "url": "https://community.n8n.io",
    "description": "Official forum for the n8n workflow-automation community — Q&A, templates, and help.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Get help and share n8n automation workflows.",
    "whyItMatters": "n8n is a popular open workflow-automation tool used to integrate SAP and non-SAP systems. Its forum is the primary place to find node patterns and troubleshoot flows.",
    "personaTags": ["role:developer", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000002",
    "verb": "INTEGRATE", "shelf": "KEEP_CURRENT", "sortOrder": 210,
    "title": "n8n Discord",
    "url": "https://discord.gg/n8n",
    "description": "Real-time chat community for n8n users and contributors.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Real-time chat with the n8n community.",
    "whyItMatters": "The n8n Discord is where users get quick answers and share in-progress automations — a fast channel when building integrations that touch SAP endpoints.",
    "personaTags": ["role:developer"]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000003",
    "verb": "INTEGRATE", "shelf": "KEEP_CURRENT", "sortOrder": 220,
    "title": "n8n on YouTube",
    "url": "https://www.youtube.com/c/n8n-io",
    "description": "Official n8n channel — tutorials, feature demos, and automation walkthroughs.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Video tutorials and demos for n8n automation.",
    "whyItMatters": "n8n's YouTube channel walks through building automations step by step — a fast way to learn node patterns before wiring up SAP integrations.",
    "personaTags": ["role:developer"]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000004",
    "verb": "INTEGRATE", "shelf": "TOOLS", "sortOrder": 230,
    "title": "n8n (n8n-io/n8n)",
    "url": "https://github.com/n8n-io/n8n",
    "description": "Source repository for the n8n workflow-automation platform.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "The open-source n8n automation engine on GitHub.",
    "whyItMatters": "The n8n repo is the source of truth for the automation engine and its nodes — the place to file issues, read code, and understand how integrations execute.",
    "personaTags": ["role:developer", "deployment:cloud"]
  },
  {
    "ID": "66333900-3rd0-0003-0001-000000000005",
    "verb": "INTEGRATE", "shelf": "TOOLS", "sortOrder": 240,
    "title": "n8n docs (n8n-io/n8n-docs)",
    "url": "https://github.com/n8n-io/n8n-docs",
    "description": "Documentation source for n8n — node references and self-hosting guides.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Docs and node references for n8n, open to contributions.",
    "whyItMatters": "The n8n-docs repo holds node references and self-hosting guides, and accepts public PRs — useful when documenting a custom SAP integration node.",
    "personaTags": ["role:developer"]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000001",
    "verb": "CONNECT", "shelf": "KEEP_CURRENT", "sortOrder": 200,
    "title": "r/SAP",
    "url": "https://www.reddit.com/r/SAP",
    "description": "Reddit community discussing SAP products, careers, and day-to-day practice.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Candid SAP discussion from the wider practitioner community.",
    "whyItMatters": "r/SAP is an unfiltered view of what SAP practitioners are dealing with — a useful pulse-check beyond official channels.",
    "personaTags": ["role:developer"]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000002",
    "verb": "CONNECT", "shelf": "KEEP_CURRENT", "sortOrder": 210,
    "title": "r/dataengineering",
    "url": "https://www.reddit.com/r/dataengineering",
    "description": "Reddit community for data engineers — tooling debates, career, and architecture.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Where data engineers debate tools and architecture.",
    "whyItMatters": "A high-signal community for data-platform trends and tradeoffs that inform how SAP data fits a broader engineering stack.",
    "personaTags": ["role:architect"]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000003",
    "verb": "CONNECT", "shelf": "KEEP_CURRENT", "sortOrder": 220,
    "title": "r/MachineLearning",
    "url": "https://www.reddit.com/r/MachineLearning",
    "description": "Reddit community covering ML research, tooling, and applied practice.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "ML research and applied practice, community-curated.",
    "whyItMatters": "Keeps developers aware of ML advances they may bring to SAP data — from model families to applied techniques.",
    "personaTags": ["role:developer"]
  },
  {
    "ID": "66333900-3rd0-0006-0001-000000000004",
    "verb": "CONNECT", "shelf": "KEEP_CURRENT", "sortOrder": 230,
    "title": "r/n8n",
    "url": "https://www.reddit.com/r/n8n",
    "description": "Reddit community for n8n workflow automation — recipes and troubleshooting.",
    "badge": "THIRD_PARTY", "isExternal": true, "isActive": true,
    "authoringStatus": "REVIEWED", "personaWeight": 0,
    "tagline": "Automation recipes and troubleshooting for n8n.",
    "whyItMatters": "A community source for n8n automation recipes, complementing the official forum when building integrations across SAP and other systems.",
    "personaTags": ["role:developer"]
  }
]
```

- [ ] **Step 2: Write the data-validation test**

Create `scripts/__tests__/seed-thirdparty-data.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN_TAGS } from '../../srv/lib/homepage/persona-tag-validator.js';

const KNOWN = new Set(KNOWN_TAGS);
const VERBS = new Set(['LEARN', 'BUILD', 'INTEGRATE', 'MODEL', 'OPERATE', 'AI', 'CONNECT']);
const SHELVES = new Set(['START_HERE', 'REFERENCE', 'TOOLS', 'KEEP_CURRENT']);

const jsonUrl = new URL('../../db/data/staging/homepage-thirdparty.json', import.meta.url);
const csvUrl = new URL('../../db/data/com.sap.developers.ims-HomepageShelves.csv', import.meta.url);

const raw = JSON.parse(readFileSync(fileURLToPath(jsonUrl), 'utf-8'));
const rows = raw.filter((r) => !r._comment);

const csvText = readFileSync(fileURLToPath(csvUrl), 'utf-8');
const csvLines = csvText.split(/\r?\n/).filter((l) => l.trim());
const csvHeader = csvLines[0].split(';');
const idIdx = csvHeader.indexOf('ID');
const verbIdx = csvHeader.indexOf('verb');
const urlIdx = csvHeader.indexOf('url');
const csvIds = new Set(csvLines.slice(1).map((l) => l.split(';')[idIdx]));
const csvVerbUrls = new Set(csvLines.slice(1).map((l) => {
  const c = l.split(';');
  return `${c[verbIdx]}|${c[urlIdx]}`;
}));

describe('homepage-thirdparty staging data', () => {
  it('parses to a non-empty array of content rows', () => {
    expect(Array.isArray(raw)).toBe(true);
    expect(rows.length).toBe(20);
  });

  it('every row has required fields with correct fixed values', () => {
    for (const r of rows) {
      expect(typeof r.ID).toBe('string');
      expect(VERBS.has(r.verb)).toBe(true);
      expect(SHELVES.has(r.shelf)).toBe(true);
      expect(Number.isInteger(r.sortOrder)).toBe(true);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.title.length).toBeLessThanOrEqual(120);
      expect(r.description.length).toBeLessThanOrEqual(280);
      expect(r.tagline.length).toBeLessThanOrEqual(140);
      expect(r.whyItMatters.length).toBeLessThanOrEqual(800);
      expect(r.badge).toBe('THIRD_PARTY');
      expect(r.isExternal).toBe(true);
      expect(r.isActive).toBe(true);
      expect(r.authoringStatus).toBe('REVIEWED');
      expect(r.personaWeight).toBe(0);
    }
  });

  it('every url is absolute https', () => {
    for (const r of rows) {
      expect(r.url.startsWith('https://')).toBe(true);
    }
  });

  it('every persona tag is in KNOWN_TAGS', () => {
    for (const r of rows) {
      expect(Array.isArray(r.personaTags)).toBe(true);
      for (const t of r.personaTags) {
        expect(KNOWN.has(t)).toBe(true);
      }
    }
  });

  it('(verb,url) pairs are unique within the file', () => {
    const seen = new Set();
    for (const r of rows) {
      const key = `${r.verb}|${r.url}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('does not collide with existing canonical CSV on ID or (verb,url)', () => {
    for (const r of rows) {
      expect(csvIds.has(r.ID)).toBe(false);
      expect(csvVerbUrls.has(`${r.verb}|${r.url}`)).toBe(false);
    }
  });
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `npx vitest run --project unit scripts/__tests__/seed-thirdparty-data.test.js`
Expected: PASS (6 tests). If a persona tag, length, or collision fails, fix the JSON — not the test.

- [ ] **Step 4: Commit**

```bash
git add db/data/staging/homepage-thirdparty.json scripts/__tests__/seed-thirdparty-data.test.js
git commit -m "feat(homepage): add third-party content staging data + validation test"
```

---

### Task 2: Idempotent loader + npm script

**Files:**
- Create: `scripts/seed-thirdparty.js`
- Modify: `package.json` (add `scripts."seed:thirdparty"`)
- Test: `scripts/__tests__/seed-thirdparty-loader.test.js`

**Interfaces:**
- Consumes: `db/data/staging/homepage-thirdparty.json` (Task 1); `KNOWN_TAGS` from `srv/lib/homepage/persona-tag-validator.js`.
- Produces: `export async function seedThirdParty(dbOverride)` → returns `{ inserted: number, updated: number }`. Upserts each staging row into the `HomepageShelves` entity in namespace `com.sap.developers.ims`, keyed on `(verb, url)`. Idempotent: re-running updates in place, never duplicates. When `dbOverride` is omitted it connects via `cds.connect.to('db')`. The file also runs as a CLI: `node scripts/seed-thirdparty.js`.

- [ ] **Step 1: Write the failing loader test**

Create `scripts/__tests__/seed-thirdparty-loader.test.js`. It uses an in-memory cds sqlite db loaded from the project model, then calls `seedThirdParty(db)` twice to prove idempotency:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { seedThirdParty } from '../seed-thirdparty.js';

let db;

beforeAll(async () => {
  cds.env.requires.db = { kind: 'sqlite', credentials: { url: ':memory:' } };
  const model = await cds.load('*');
  db = await cds.deploy(model).to('sqlite::memory:');
}, 60000);

describe('seedThirdParty', () => {
  it('first run inserts all rows', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(20);
    expect(res.updated).toBe(0);
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const count = await SELECT.from(HomepageShelves).where({ badge: 'THIRD_PARTY', ID: { like: '66333900-3rd0-%' } });
    expect(count.length).toBe(20);
  });

  it('second run updates in place, inserts nothing (idempotent)', async () => {
    const res = await seedThirdParty(db);
    expect(res.inserted).toBe(0);
    expect(res.updated).toBe(20);
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const all = await SELECT.from(HomepageShelves).where({ ID: { like: '66333900-3rd0-%' } });
    expect(all.length).toBe(20);
  });

  it('persists personaTags as an array', async () => {
    const { HomepageShelves } = cds.entities('com.sap.developers.ims');
    const vercel = await SELECT.one.from(HomepageShelves).where({ verb: 'BUILD', url: 'https://vercel.com' });
    expect(vercel).toBeTruthy();
    expect(vercel.personaTags).toContain('role:developer');
    expect(vercel.badge).toBe('THIRD_PARTY');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit scripts/__tests__/seed-thirdparty-loader.test.js`
Expected: FAIL — `Cannot find module '../seed-thirdparty.js'` (or `seedThirdParty is not a function`).

- [ ] **Step 3: Write the loader**

Create `scripts/seed-thirdparty.js`. Mirror the `srv/lib/seed-poc-puzzle.js` connect/entities/CQL pattern; validate persona tags before writing:

```js
#!/usr/bin/env node
// Idempotent loader for homepage third-party content.
// Upserts db/data/staging/homepage-thirdparty.json into HomepageShelves,
// keyed on (verb, url). Run against DEV: `npm run seed:thirdparty`.
// PROD promotion is manual — see the file's _comment and the spec.
import cds from '@sap/cds';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KNOWN_TAGS } from '../srv/lib/homepage/persona-tag-validator.js';

const KNOWN = new Set(KNOWN_TAGS);
const DATA_URL = new URL('../db/data/staging/homepage-thirdparty.json', import.meta.url);

function loadRows() {
  const raw = JSON.parse(readFileSync(fileURLToPath(DATA_URL), 'utf-8'));
  return raw.filter((r) => !r._comment);
}

function validate(rows) {
  const errors = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.verb || !r.url) errors.push(`row ${r.ID || '?'}: missing verb/url`);
    if (typeof r.url !== 'string' || !r.url.startsWith('https://')) {
      errors.push(`row ${r.ID}: url must be absolute https`);
    }
    const key = `${r.verb}|${r.url}`;
    if (seen.has(key)) errors.push(`duplicate (verb,url): ${key}`);
    seen.add(key);
    for (const t of r.personaTags || []) {
      if (!KNOWN.has(t)) errors.push(`row ${r.ID}: unknown personaTag "${t}"`);
    }
  }
  if (errors.length) {
    throw new Error(`seed-thirdparty validation failed:\n  ${errors.join('\n  ')}`);
  }
}

export async function seedThirdParty(dbOverride) {
  const db = dbOverride ?? await cds.connect.to('db');
  const { HomepageShelves } = cds.entities('com.sap.developers.ims');
  const rows = loadRows();
  validate(rows);

  let inserted = 0;
  let updated = 0;
  for (const r of rows) {
    const existing = await SELECT.one.from(HomepageShelves).where({ verb: r.verb, url: r.url });
    if (existing) {
      const { ID, ...patch } = r;   // keep existing ID on update
      await UPDATE(HomepageShelves).set(patch).where({ ID: existing.ID });
      updated++;
    } else {
      await INSERT.into(HomepageShelves).entries(r);
      inserted++;
    }
  }
  return { inserted, updated };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  cds.load('*')
    .then(() => seedThirdParty())
    .then(({ inserted, updated }) => {
      console.log(`seed-thirdparty: ${inserted} inserted, ${updated} updated`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project unit scripts/__tests__/seed-thirdparty-loader.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the npm script**

In `package.json` `scripts`, add (bind to the active profile's DB, matching the `seed-poc-puzzle` convention):

```json
"seed:thirdparty": "cds bind --exec -- node scripts/seed-thirdparty.js"
```

- [ ] **Step 6: Run the full unit suite for the new files to confirm no regressions**

Run: `npx vitest run --project unit scripts/__tests__/seed-thirdparty-data.test.js scripts/__tests__/seed-thirdparty-loader.test.js`
Expected: PASS (9 tests total).

- [ ] **Step 7: Commit**

```bash
git add scripts/seed-thirdparty.js scripts/__tests__/seed-thirdparty-loader.test.js package.json
git commit -m "feat(homepage): idempotent loader + seed:thirdparty script for third-party content"
```

---

### Task 3: Wire loader into DEV load + promotion note

**Files:**
- Modify: `docs/superpowers/specs/2026-07-30-homepage-thirdparty-content-design.md` (append a short "run log / status" note — optional, only if it helps the reviewer)
- Verify only: no code changes required here.

**Interfaces:**
- Consumes: `npm run seed:thirdparty` (Task 2).
- Produces: 20 third-party rows present in the DEV `db` service, reviewable on the homepage verb pages.

- [ ] **Step 1: Load into DEV (manual, requires DEV binding)**

This step runs against the live DEV HANA container and needs `cds bind` to the DEV service key — it is NOT part of CI. The implementer (or the user) runs:

Run: `npm run seed:thirdparty`
Expected: `seed-thirdparty: 20 inserted, 0 updated` on first run; `0 inserted, 20 updated` on any re-run.

If DEV binding is unavailable in the execution environment, STOP and report that Task 3 requires the user to run `npm run seed:thirdparty` against DEV — do not fake it. Tasks 1–2 are fully complete and testable without DEV.

- [ ] **Step 2: Verify on DEV**

Open the homepage / verb sub-pages (`/build/`, `/model/`, `/ai/`, `/integrate/`, `/connect/`) and confirm the third-party rows appear with the `THIRD_PARTY` badge in the expected shelves. Confirm PROD is unchanged (no deploy of the canonical CSV happened).

- [ ] **Step 3: (No commit)** — this task changes no tracked files unless a status note is added.

---

## Self-Review

**1. Spec coverage:**
- §3 approach (staging file + loader, DEV-only) → Tasks 1, 2, 3. ✓
- §4 entry conventions (fixed field values, ID prefix, sortOrder ≥200) → Task 1 JSON + test. ✓
- §4 persona vocab constraint → Task 1 test + Task 2 loader `validate()`, both import real `KNOWN_TAGS`. ✓
- §5 content set (20 entries incl. Vercel) → Task 1 JSON (20 objects), test asserts `length === 20`. ✓
- §6 files → all created in Tasks 1–2. ✓
- §7 loader behaviour + tests (idempotent on (verb,url), fail-loud validation, no-DB data test, collision test) → Tasks 1 & 2. ✓
- §8 promotion note → `_comment` in JSON (Task 1) + loader header comment (Task 2). ✓
- §9 out-of-scope (no schema change, no render change) → honored; no task touches `db/homepage.cds` or `verb-spine.html`. ✓

**2. Placeholder scan:** No TBD/TODO; all code blocks are complete; all 20 entries written out in full. ✓

**3. Type consistency:** `seedThirdParty(dbOverride)` → `{inserted, updated}` used identically in loader and its test. `KNOWN_TAGS` (named export) imported the same way in data test, loader, and matches the existing `persona-tag-validator.js` export. Entity resolved as `cds.entities('com.sap.developers.ims').HomepageShelves` in loader and test. ✓

**Note on CLI DB-connect:** `seed:thirdparty` uses `cds bind --exec` (same as `seed-poc-puzzle`) so it targets the profile-bound DB; the loader's `cds.connect.to('db')` resolves that binding. Tests never hit the CLI path — they pass an in-memory `dbOverride`.
