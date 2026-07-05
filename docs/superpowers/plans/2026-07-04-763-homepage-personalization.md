# Homepage personalization (#763) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the developer-portal homepage adjust and shift based on the signed-in user's learning configuration (deployment/role/cloud), per issue #763.

**Architecture:** Static Hugo shell + Vue-island hydration for personalizable slots only. One new authenticated endpoint (`GET /homepage/personalized`) returns a single envelope (verb order, For-you row, teaser order, shelf overrides, filter tags) with ETag/304. Two-layer personalization: a small static `role → verb-order` map + admin-editable `personaTags`/`personaWeight`/`personaHidden` on `HomepageShelves` and a new `HomepageForYouCandidates` entity.

**Tech Stack:** CAP Node.js, CDS on HANA Cloud, Vue 3 + Vite islands, UI5 Web Components, Hugo, `@sap/cds` service tests, Vitest + happy-dom.

**Spec:** [docs/superpowers/specs/2026-07-04-763-homepage-personalization-design.md](../specs/2026-07-04-763-homepage-personalization-design.md)

## Global Constraints

- **Auth boundary:** the new endpoint MUST use `@requires: 'authenticated-user'`. Anonymous requests return 401. Kill switch (`HomepageConfig.personalizationEnabled = false`) returns 204.
- **CDN safety:** every 200 response MUST set `Cache-Control: private, no-store` AND `X-Personalization: 1`. A smoke test asserts both.
- **Persona-tag vocabulary is frozen** at v1: `role:{developer,architect,sysadmin,student}`, `deployment:{cloud,onprem}`, `cloud:{btp,aws,azure,gcp,alibaba,oracle,ibm}`. Values come from `srv/lib/branch/profile-fields.js` (`PROFILE_VOCAB`). Validator MUST import that module directly, not copy the list.
- **CI Node 22 vs local Node 24 traps** (per project memory):
  - Use `cds.entities('com.sap.developers.ims')` refs for the new entities in service handlers — bare projection names in `SELECT.from('X')` resolve on Node 24 but not Node 22.
  - Self-reference `x.context = x` on any `EventContext` mocks; test-scoped `cds.context = X` leaks between `it()` boundaries in Vitest 4 forks pool.
- **Windows CRLF:** end every new file with LF only. Git attributes handle mixed content, but subagent-generated files can regress; explicit LF endings avoid the JS regex `$` trap.
- **`xs-security.json` dual-file:** no new scopes required by this feature. If any task ever needs a new scope, edit BOTH `xs-security.json` and `.deploy/xs-security.json`.
- **`ignore-scripts=true` globally**: assume `npm run setup` has been run once in the worktree. Do not add `postinstall` scripts.
- **Never edit `hugo/content/tutorials/`** — generated. Only `hugo/layouts/`, `hugo/assets/`, `hugo-apps/`, `srv/`, `db/`, `docs/`, `test/`, `app/admin-annotations.cds`.
- **Every task commits its own change** and runs relevant tests. No mega-commits.

## File Structure

| File | Responsibility |
|---|---|
| `db/homepage.cds` — MODIFY | Add `personaTags`/`personaWeight`/`personaHidden` to `HomepageShelves`; add new `HomepageForYouCandidates` entity |
| `srv/homepage-service.cds` — MODIFY | Types + `personalized()` function |
| `srv/homepage-service.js` — MODIFY | Handler that assembles the envelope, sets headers, ETag/304 |
| `srv/lib/homepage/persona-map.js` — CREATE | Static base order + role tilt; pure function `computeVerbOrder({profile, tagCountsPerVerb})` |
| `srv/lib/homepage/persona-scoring.js` — CREATE | Pure functions `matches(entry, profile)`, `scoreEntry(entry, profile)`, `isHidden(entry, profile)` |
| `srv/lib/homepage/persona-tag-validator.js` — CREATE | `validateTags(tags)`; imports `PROFILE_VOCAB` |
| `srv/lib/homepage/personalized-envelope.js` — CREATE | Builds the envelope (verbOrder/forYou/teaserOrder/shelfOverrides/filter tags) from profile + DB rows |
| `srv/admin-service.cds` — MODIFY | Expose `HomepageForYouCandidates` and the new fields on `HomepageShelves` |
| `srv/admin-service.js` — MODIFY | Save-time validator handler for persona tag fields |
| `app/admin-annotations.cds` — MODIFY | New Personalization facet on `HomepageShelves`; list report + object page for `HomepageForYouCandidates` |
| `srv/jobs/homepage-link-health.js` — MODIFY | Include `HomepageForYouCandidates.targetSlug` URLs |
| `hugo-apps/src/homepage-personalizer/coordinator.ts` — CREATE | Boot, cache, fetch, dispatch |
| `hugo-apps/src/homepage-personalizer/verb-order.ts` — CREATE | Row-2 DOM reorder |
| `hugo-apps/src/homepage-personalizer/for-you-row.vue` — CREATE | Row-2b population |
| `hugo-apps/src/homepage-personalizer/teaser-rerank.ts` — CREATE | Row-5 rerank + missing-card fetch |
| `hugo-apps/src/homepage-personalizer/shelf-rerank.ts` — CREATE | Verb sub-page shelf reorder + hide |
| `hugo-apps/src/homepage-personalizer/video-filter.ts` — CREATE | Pure filter fn, imported by existing VideoBand |
| `hugo-apps/src/homepage-personalizer/rss-filter.ts` — CREATE | Pure filter fn, imported by existing CommunityLane |
| `hugo-apps/src/homepage-personalizer/personalized-badge.ts` — CREATE | Badge strip rendering |
| `hugo-apps/src/homepage-personalizer/prefs-broadcast.ts` — CREATE | `BroadcastChannel` + `storage` fallback |
| `hugo-apps/src/homepage-personalizer/index.ts` — CREATE | Vite entry — wires coordinator to DOM |
| `hugo-apps/src/homepage-bands/VideoBand.vue` — MODIFY | Import video-filter, apply after fetch |
| `hugo-apps/src/homepage-bands/CommunityLane.vue` — MODIFY | Import rss-filter, apply after fetch |
| `hugo-apps/src/me/LearningPreferences.vue` — MODIFY | Broadcast on save |
| `hugo-apps/vite.config.ts` — MODIFY | Register `homepage-personalizer` entry + gzip budget |
| `hugo/layouts/partials/homepage/verb-spine.html` — MODIFY | `data-personalize="verb-order"` attribute |
| `hugo/layouts/partials/homepage/for-you.html` — CREATE | Empty slot |
| `hugo/layouts/index.html` — MODIFY | Include for-you.html between verb-spine and events |
| `hugo/layouts/partials/homepage/teaser.html` (or equivalent) — MODIFY | `data-personalize="teaser-rerank"` |
| `hugo/layouts/verb/list.html` — MODIFY | `data-personalize="shelf-rerank"` per shelf; `data-verb` |
| `hugo/layouts/_default/baseof.html` — MODIFY | Script tag for `/js/homepage-personalizer.js` on `homepage` + `verb-*` page-kinds |
| `docs/developers/architecture/homepage-personalization.md` — CREATE | Platform-engineering condensed doc |
| `docs/authors/homepage-for-you-runbook.md` — CREATE | Curator guide |
| `docs/developers/architecture/homepage.md` — MODIFY | New "Personalization" section pointer |
| `docs/developers/reference/tutorials-ims-gotchas.md` — MODIFY | ETag/304 + `X-Personalization: 1` notes |

Tests are placed alongside their targets under `test/unit/homepage/`, `test/integration/homepage/`, `test/smoke/`, `hugo-apps/src/homepage-personalizer/__tests__/`.

---

## Task Ordering Rationale

The plan front-loads the **narrow slice that works end-to-end** (schema → endpoint → coordinator → verb reorder + badge) as Tasks 1-9 so we can smoke-test personalization on real infrastructure before layering in the remaining surfaces. Everything after Task 9 is additive.

I'm writing the task bodies in three chunks to stay within message limits. This file has Tasks 1-6 (schema + service backbone). I'll append Tasks 7-14 (endpoint envelope + first client surfaces + admin) and Tasks 15-20 (remaining surfaces + docs + rollout) in follow-up edits — each chunk is a plain append with no re-editing of earlier tasks.

---

## Task 1: Extend `HomepageShelves` with persona fields; add `HomepageForYouCandidates`

**Files:**
- Modify: `db/homepage.cds`
- Modify: `db/schema-drift.test.js` (if it exists; else `test/unit/schema-drift.test.js`)
- Test: `test/unit/homepage/schema-drift-persona.test.js`

**Interfaces:**
- Produces: `HomepageShelves.personaTags: array of String(40)`, `HomepageShelves.personaWeight: Integer`, `HomepageShelves.personaHidden: array of String(40)`; new `HomepageForYouCandidates` entity with fields per spec §5.2.

- [ ] **Step 1: Write the failing schema-drift test**

```js
// test/unit/homepage/schema-drift-persona.test.js
const cds = require('@sap/cds');
const { describe, it, expect, beforeAll } = require('vitest');

describe('HomepageShelves + HomepageForYouCandidates persona fields', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(['db/schema.cds', 'db/homepage.cds']);
  });

  it('HomepageShelves has personaTags, personaWeight, personaHidden', () => {
    const e = model.definitions['com.sap.developers.ims.HomepageShelves'];
    expect(e).toBeDefined();
    expect(e.elements.personaTags).toBeDefined();
    expect(e.elements.personaTags.items?.type).toBe('cds.String');
    expect(e.elements.personaWeight?.type).toBe('cds.Integer');
    expect(e.elements.personaHidden).toBeDefined();
    expect(e.elements.personaHidden.items?.type).toBe('cds.String');
  });

  it('HomepageForYouCandidates exists with required fields', () => {
    const e = model.definitions['com.sap.developers.ims.HomepageForYouCandidates'];
    expect(e).toBeDefined();
    for (const f of ['kind', 'targetSlug', 'title', 'description', 'imageUrl',
                     'personaTags', 'personaWeight', 'personaHidden',
                     'sortOrder', 'active']) {
      expect(e.elements[f], `field ${f} missing`).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run test and verify failure**

Run: `npx vitest run test/unit/homepage/schema-drift-persona.test.js`
Expected: FAIL — `personaTags` undefined; `HomepageForYouCandidates` undefined.

- [ ] **Step 3: Extend `db/homepage.cds`**

Append inside the existing `HomepageShelves` entity body (before the closing `}` on line 52):

```cds
  // (#763) Persona tag scoring — see design §5.1.
  // Grammar: '<field>:<value>' drawn from PROFILE_VOCAB
  //   role:{developer,architect,sysadmin,student}
  //   deployment:{cloud,onprem}
  //   cloud:{btp,aws,azure,gcp,alibaba,oracle,ibm}
  // Save-time validator in srv/admin-service.js rejects typos.
  personaTags   : array of String(40);
  personaWeight : Integer default 0;
  personaHidden : array of String(40);
```

Append at end of file:

```cds
// (#763) For-you row candidates. Distinct from HomepageShelves because
// being featured in For-you is orthogonal to being in the directory
// footer. Design §5.2.
type ForYouKind : String enum { tutorial; mission; video; blog; shelf; }

entity HomepageForYouCandidates : cuid, managed {
  kind          : ForYouKind    @mandatory @assert.range;
  targetSlug    : String(200)   @mandatory;
  title         : String(255)   @mandatory;
  description   : String(500);
  imageUrl      : String(500);
  personaTags   : array of String(40);
  personaWeight : Integer       default 0;
  personaHidden : array of String(40);
  sortOrder     : Integer       default 100;
  active        : Boolean       default true;
  linkStatus    : HomepageLinkStatus default 'UNKNOWN' @assert.range;
  lastChecked   : Timestamp;
}
```

- [ ] **Step 4: Run schema-drift test to verify pass**

Run: `npx vitest run test/unit/homepage/schema-drift-persona.test.js`
Expected: PASS both tests.

- [ ] **Step 5: Regenerate `db/last-dev/` snapshot (HANA schema tests)**

Run: `npx cds build --production`
Verify: `git status` shows changes under `db/last-dev/` (e.g., `hana-schema.sql`).

- [ ] **Step 6: Run the full unit test suite to catch collateral damage**

Run: `npm test -- --run` (or `npx vitest run` if scripts differ)
Expected: PASS. If any HANA-schema or drift test fails, fix by regenerating last-dev.

- [ ] **Step 7: Commit**

```bash
git add db/homepage.cds db/last-dev/ test/unit/homepage/schema-drift-persona.test.js
git commit -m "feat(#763): add persona tag fields + HomepageForYouCandidates entity"
```

---

## Task 2: `srv/lib/homepage/persona-tag-validator.js` (pure, TDD)

**Files:**
- Create: `srv/lib/homepage/persona-tag-validator.js`
- Test: `test/unit/homepage/persona-tag-validator.test.js`

**Interfaces:**
- Consumes: `PROFILE_VOCAB` from `srv/lib/branch/profile-fields.js`.
- Produces:
  - `validateTags(tags: string[]): { ok: true } | { ok: false, invalid: string[] }` — rejects unknown values; empty array is `{ ok: true }`.
  - `KNOWN_TAGS: string[]` — flattened allowlist, exported for admin UI hints.

- [ ] **Step 1: Write failing test**

```js
// test/unit/homepage/persona-tag-validator.test.js
import { describe, it, expect } from 'vitest';
import { validateTags, KNOWN_TAGS } from '../../../srv/lib/homepage/persona-tag-validator.js';

describe('validateTags', () => {
  it('accepts every value in the PROFILE_VOCAB', () => {
    for (const tag of KNOWN_TAGS) {
      expect(validateTags([tag])).toEqual({ ok: true });
    }
  });

  it('accepts empty array', () => {
    expect(validateTags([])).toEqual({ ok: true });
  });

  it('rejects unknown field prefix', () => {
    const r = validateTags(['user:admin']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toContain('user:admin');
  });

  it('rejects unknown value within known field', () => {
    const r = validateTags(['role:manager']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['role:manager']);
  });

  it('rejects malformed tag (no colon)', () => {
    const r = validateTags(['developer']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['developer']);
  });

  it('lists all invalid tags in a mixed batch', () => {
    const r = validateTags(['role:developer', 'role:manager', 'cloud:oops']);
    expect(r.ok).toBe(false);
    expect(r.invalid).toEqual(['role:manager', 'cloud:oops']);
  });

  it('KNOWN_TAGS contains role:developer and cloud:btp', () => {
    expect(KNOWN_TAGS).toContain('role:developer');
    expect(KNOWN_TAGS).toContain('cloud:btp');
    expect(KNOWN_TAGS).toContain('deployment:onprem');
  });
});
```

- [ ] **Step 2: Run test, expect fail**

Run: `npx vitest run test/unit/homepage/persona-tag-validator.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the validator**

```js
// srv/lib/homepage/persona-tag-validator.js
//
// (#763) Save-time validator for HomepageShelves.personaTags /
// personaHidden and HomepageForYouCandidates.personaTags / personaHidden.
// Source of truth is srv/lib/branch/profile-fields.js — no duplication.
// Design §5.3.

import { PROFILE_VOCAB } from '../branch/profile-fields.js';

// Flatten { field: [v1, v2] } into ['field:v1', 'field:v2'].
export const KNOWN_TAGS = Object.entries(PROFILE_VOCAB).flatMap(
  ([field, values]) => values.map((v) => `${field}:${v}`)
);
const KNOWN = new Set(KNOWN_TAGS);

export function validateTags(tags) {
  if (!Array.isArray(tags)) return { ok: false, invalid: [String(tags)] };
  const invalid = tags.filter((t) => !KNOWN.has(t));
  return invalid.length === 0 ? { ok: true } : { ok: false, invalid };
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run test/unit/homepage/persona-tag-validator.test.js`
Expected: PASS 7 tests.

- [ ] **Step 5: Add a drift guard test**

```js
// test/unit/homepage/persona-fields-sync.test.js
import { describe, it, expect } from 'vitest';
import { KNOWN_TAGS } from '../../../srv/lib/homepage/persona-tag-validator.js';
import { PROFILE_VOCAB } from '../../../srv/lib/branch/profile-fields.js';

describe('KNOWN_TAGS is derived from PROFILE_VOCAB', () => {
  it('has one tag per field/value pair, no more, no less', () => {
    const expected = Object.entries(PROFILE_VOCAB).flatMap(
      ([f, vs]) => vs.map((v) => `${f}:${v}`)
    );
    expect(KNOWN_TAGS.sort()).toEqual(expected.sort());
  });
});
```

Run: `npx vitest run test/unit/homepage/persona-fields-sync.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/homepage/persona-tag-validator.js test/unit/homepage/persona-tag-validator.test.js test/unit/homepage/persona-fields-sync.test.js
git commit -m "feat(#763): persona-tag save-time validator, PROFILE_VOCAB drift guard"
```

---

## Task 3: `srv/lib/homepage/persona-scoring.js` (pure, TDD)

**Files:**
- Create: `srv/lib/homepage/persona-scoring.js`
- Test: `test/unit/homepage/persona-scoring.test.js`

**Interfaces:**
- Produces:
  - `matches(entry: {personaTags?: string[]}, profile: {role?, deployment?, cloud?}): boolean` — true if any of `entry.personaTags` matches a non-null profile field.
  - `isHidden(entry: {personaHidden?: string[]}, profile): boolean` — same match rule, over the hidden list.
  - `scoreEntry(entry: {personaTags?, personaWeight?}, profile): number` — `personaWeight` if `matches(...)` else `0`.
  - `rankShelves(entries: any[], profile): any[]` — sort by `(-score, sortOrder, title)`, remove any where `isHidden` is true.
  - `rankForYou(entries: any[], profile, {min, max}): any[]` — same rules, plus `matches` must be true; returns `[]` when < `min` survive, else at most `max`.

- [ ] **Step 1: Write failing tests**

```js
// test/unit/homepage/persona-scoring.test.js
import { describe, it, expect } from 'vitest';
import { matches, isHidden, scoreEntry, rankShelves, rankForYou }
  from '../../../srv/lib/homepage/persona-scoring.js';

const dev = { role: 'developer', deployment: 'cloud', cloud: 'aws' };
const anon = { role: null, deployment: null, cloud: null };

describe('matches', () => {
  it('is false for empty tags', () => {
    expect(matches({ personaTags: [] }, dev)).toBe(false);
  });
  it('is true when role matches', () => {
    expect(matches({ personaTags: ['role:developer'] }, dev)).toBe(true);
  });
  it('is false when tag field is not set on profile', () => {
    expect(matches({ personaTags: ['role:developer'] }, anon)).toBe(false);
  });
  it('is true when any tag matches (OR semantics)', () => {
    expect(matches({ personaTags: ['role:architect', 'cloud:aws'] }, dev)).toBe(true);
  });
});

describe('isHidden', () => {
  it('is false when hidden list is empty or absent', () => {
    expect(isHidden({}, dev)).toBe(false);
    expect(isHidden({ personaHidden: [] }, dev)).toBe(false);
  });
  it('is true when any hidden tag matches', () => {
    expect(isHidden({ personaHidden: ['role:developer'] }, dev)).toBe(true);
  });
});

describe('scoreEntry', () => {
  it('is 0 when no match', () => {
    expect(scoreEntry({ personaTags: ['role:student'], personaWeight: 5 }, dev)).toBe(0);
  });
  it('is personaWeight on match', () => {
    expect(scoreEntry({ personaTags: ['role:developer'], personaWeight: 5 }, dev)).toBe(5);
  });
  it('is 0 when weight is undefined even with match', () => {
    expect(scoreEntry({ personaTags: ['role:developer'] }, dev)).toBe(0);
  });
});

describe('rankShelves', () => {
  const rows = [
    { ID: 'a', title: 'A', sortOrder: 200, personaTags: ['role:architect'], personaWeight: 10 },
    { ID: 'b', title: 'B', sortOrder: 100, personaTags: ['role:developer'], personaWeight: 10 },
    { ID: 'c', title: 'C', sortOrder: 50,  personaTags: [], personaWeight: 0 },
    { ID: 'd', title: 'D', sortOrder: 300, personaHidden: ['role:developer'] },
  ];

  it('hides entries whose personaHidden matches', () => {
    const r = rankShelves(rows, dev);
    expect(r.map(x => x.ID)).not.toContain('d');
  });

  it('scored entries lead untagged ones', () => {
    const r = rankShelves(rows, dev);
    expect(r[0].ID).toBe('b');           // matched developer, weight 10
    expect(r.at(-1).ID).toBe('a');       // no match, higher sortOrder
  });

  it('preserves stable order on ties (by sortOrder then title)', () => {
    const tied = [
      { ID: '2', title: 'Bb', sortOrder: 100 },
      { ID: '1', title: 'Aa', sortOrder: 100 },
    ];
    const r = rankShelves(tied, anon);
    expect(r.map(x => x.ID)).toEqual(['1', '2']);
  });
});

describe('rankForYou', () => {
  it('returns empty when fewer than min match', () => {
    const rows = [
      { ID: '1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
      { ID: '2', personaTags: ['role:student'],   personaWeight: 5, sortOrder: 100 },
    ];
    expect(rankForYou(rows, dev, { min: 3, max: 8 })).toEqual([]);
  });

  it('drops untagged candidates', () => {
    const rows = [
      { ID: '1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
      { ID: '2', personaTags: ['role:developer'], personaWeight: 3, sortOrder: 100 },
      { ID: '3', personaTags: ['role:developer'], personaWeight: 0, sortOrder: 100 },
      { ID: '4', personaTags: [],                  personaWeight: 99, sortOrder: 100 },
    ];
    const r = rankForYou(rows, dev, { min: 3, max: 8 });
    expect(r.map(x => x.ID)).toEqual(['1', '2', '3']);   // 4 excluded (no match)
  });

  it('caps at max', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ID: String(i), personaTags: ['role:developer'], personaWeight: 10 - i, sortOrder: 100,
    }));
    const r = rankForYou(rows, dev, { min: 1, max: 3 });
    expect(r).toHaveLength(3);
    expect(r.map(x => x.ID)).toEqual(['0', '1', '2']);
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `npx vitest run test/unit/homepage/persona-scoring.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement scoring**

```js
// srv/lib/homepage/persona-scoring.js
//
// (#763) Deterministic persona scoring — no randomness, stable ties.
// Design §7.2.

function anyTagMatchesProfile(tags, profile) {
  if (!Array.isArray(tags) || tags.length === 0) return false;
  for (const t of tags) {
    const idx = t.indexOf(':');
    if (idx <= 0) continue;
    const field = t.slice(0, idx);
    const value = t.slice(idx + 1);
    if (profile[field] && profile[field] === value) return true;
  }
  return false;
}

export function matches(entry, profile) {
  return anyTagMatchesProfile(entry?.personaTags, profile || {});
}

export function isHidden(entry, profile) {
  return anyTagMatchesProfile(entry?.personaHidden, profile || {});
}

export function scoreEntry(entry, profile) {
  if (!matches(entry, profile)) return 0;
  return Number.isFinite(entry?.personaWeight) ? entry.personaWeight : 0;
}

function compareRanked(a, b) {
  if (b._score !== a._score) return b._score - a._score;
  const sa = a.sortOrder ?? 100;
  const sb = b.sortOrder ?? 100;
  if (sa !== sb) return sa - sb;
  return String(a.title ?? '').localeCompare(String(b.title ?? ''));
}

export function rankShelves(entries, profile) {
  const p = profile || {};
  return entries
    .filter((e) => !isHidden(e, p))
    .map((e) => ({ ...e, _score: scoreEntry(e, p) }))
    .sort(compareRanked)
    .map(({ _score, ...rest }) => rest);
}

export function rankForYou(entries, profile, { min, max }) {
  const p = profile || {};
  const kept = entries
    .filter((e) => !isHidden(e, p) && matches(e, p))
    .map((e) => ({ ...e, _score: scoreEntry(e, p) }))
    .sort(compareRanked);
  if (kept.length < min) return [];
  return kept.slice(0, max).map(({ _score, ...rest }) => rest);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run test/unit/homepage/persona-scoring.test.js`
Expected: PASS all tests.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/homepage/persona-scoring.js test/unit/homepage/persona-scoring.test.js
git commit -m "feat(#763): persona scoring (matches, isHidden, scoreEntry, rankShelves, rankForYou)"
```

---

## Task 4: `srv/lib/homepage/persona-map.js` (static role→verb-order, TDD)

**Files:**
- Create: `srv/lib/homepage/persona-map.js`
- Test: `test/unit/homepage/persona-map.test.js`

**Interfaces:**
- Produces:
  - `BASE_ORDER: readonly string[]` — canonical 6-verb order, lowercase.
  - `computeVerbOrder(profile, tagCountsPerVerb?: Record<string, number>): string[]` — length 6, unique verbs from `BASE_ORDER`.

Tilt rule (single, deterministic):
1. Start with `ROLE_TILT[profile.role]` or `BASE_ORDER` if role is null/unknown.
2. If `tagCountsPerVerb` is provided, find the verb with the strictly greatest count (ties → skip); if that verb is not already in position 0 or 1, move it up by exactly one slot (swap with the neighbor above it).

- [ ] **Step 1: Write failing tests**

```js
// test/unit/homepage/persona-map.test.js
import { describe, it, expect } from 'vitest';
import { BASE_ORDER, computeVerbOrder } from '../../../srv/lib/homepage/persona-map.js';

describe('computeVerbOrder', () => {
  it('returns BASE_ORDER when profile has no role', () => {
    expect(computeVerbOrder({})).toEqual([...BASE_ORDER]);
  });

  it('developer role leads with build', () => {
    const r = computeVerbOrder({ role: 'developer' });
    expect(r[0]).toBe('build');
    expect(r).toHaveLength(6);
    expect(new Set(r).size).toBe(6);
  });

  it('architect role leads with integrate', () => {
    expect(computeVerbOrder({ role: 'architect' })[0]).toBe('integrate');
  });

  it('sysadmin role leads with operate', () => {
    expect(computeVerbOrder({ role: 'sysadmin' })[0]).toBe('operate');
  });

  it('student role leads with learn', () => {
    expect(computeVerbOrder({ role: 'student' })[0]).toBe('learn');
  });

  it('unknown role falls back to base order', () => {
    expect(computeVerbOrder({ role: 'manager' })).toEqual([...BASE_ORDER]);
  });

  it('tilts a strictly-heaviest verb up one slot', () => {
    // developer base: [build, learn, integrate, ai, operate, connect]
    // ai has the most tagged shelves → moves from index 3 to index 2.
    const r = computeVerbOrder({ role: 'developer' }, { ai: 5, integrate: 2 });
    expect(r).toEqual(['build', 'learn', 'ai', 'integrate', 'operate', 'connect']);
  });

  it('does not tilt when the heaviest verb is already at index 0 or 1', () => {
    const r = computeVerbOrder({ role: 'developer' }, { build: 10 });
    expect(r).toEqual(['build', 'learn', 'integrate', 'ai', 'operate', 'connect']);
  });

  it('does not tilt on a tie for heaviest', () => {
    const r = computeVerbOrder({ role: 'developer' }, { ai: 5, operate: 5 });
    expect(r).toEqual(['build', 'learn', 'integrate', 'ai', 'operate', 'connect']);
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `npx vitest run test/unit/homepage/persona-map.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// srv/lib/homepage/persona-map.js
//
// (#763) Static persona → verb-order map. Not admin-editable in v1 —
// verb order is a strong design choice. Design §7.1.

export const BASE_ORDER = Object.freeze(
  ['learn', 'build', 'integrate', 'operate', 'ai', 'connect']
);

const ROLE_TILT = Object.freeze({
  developer: ['build', 'learn', 'integrate', 'ai', 'operate', 'connect'],
  architect: ['integrate', 'build', 'operate', 'learn', 'ai', 'connect'],
  sysadmin:  ['operate', 'integrate', 'build', 'connect', 'learn', 'ai'],
  student:   ['learn', 'build', 'ai', 'integrate', 'connect', 'operate'],
});

function heaviestUnique(counts) {
  if (!counts) return null;
  let best = null, bestCount = -Infinity, tie = false;
  for (const [verb, n] of Object.entries(counts)) {
    if (n > bestCount) { best = verb; bestCount = n; tie = false; }
    else if (n === bestCount) { tie = true; }
  }
  if (bestCount <= 0 || tie) return null;
  return best;
}

export function computeVerbOrder(profile, tagCountsPerVerb) {
  const p = profile || {};
  const order = ROLE_TILT[p.role] ? [...ROLE_TILT[p.role]] : [...BASE_ORDER];

  const heavy = heaviestUnique(tagCountsPerVerb);
  if (heavy) {
    const idx = order.indexOf(heavy);
    if (idx >= 2) {
      // Swap with the neighbor above.
      [order[idx - 1], order[idx]] = [order[idx], order[idx - 1]];
    }
  }
  return order;
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run test/unit/homepage/persona-map.test.js`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/homepage/persona-map.js test/unit/homepage/persona-map.test.js
git commit -m "feat(#763): static role->verb-order map with single-slot tilt"
```

---

## Task 5: `srv/lib/homepage/personalized-envelope.js` (composition, TDD)

**Files:**
- Create: `srv/lib/homepage/personalized-envelope.js`
- Test: `test/unit/homepage/personalized-envelope.test.js`

**Interfaces:**
- Consumes: `rankShelves`, `rankForYou` (Task 3); `computeVerbOrder`, `BASE_ORDER` (Task 4).
- Produces:
  - `buildEnvelope({profile, shelves, forYouCandidates, teaserSlugs}): Envelope` where `Envelope = {profile, verbOrder, forYou, teaserOrder, shelfOverrides, videoFilterTags, rssFilterTags}` per design §6.
  - `hashEnvelope(env): string` — stable SHA-1 (hex, first 8 chars for readability) over the JSON body.

Notes:
- `teaserSlugs` is the current static top-8 slugs plus any admin-featured candidate slugs (up to 12 total, dedup order preserved).
- `shelves` is the full active `HomepageShelves` set; envelope buckets by verb, calls `rankShelves`, computes `hidden` IDs, returns a `reorder` list per verb (only rows whose position changes from the static order — an empty `reorder` means "no client action needed").
- Filter tags derive from profile: role adds one, cloud adds one, deployment adds one; drop nulls.

- [ ] **Step 1: Write failing tests**

```js
// test/unit/homepage/personalized-envelope.test.js
import { describe, it, expect } from 'vitest';
import { buildEnvelope, hashEnvelope } from '../../../srv/lib/homepage/personalized-envelope.js';

const dev = { role: 'developer', deployment: 'cloud', cloud: 'aws' };
const shelves = [
  { ID: 's1', verb: 'BUILD',     shelf: 'START_HERE', sortOrder: 100, title: 'S1', personaTags: ['role:developer'], personaWeight: 10 },
  { ID: 's2', verb: 'BUILD',     shelf: 'START_HERE', sortOrder: 50,  title: 'S2' },
  { ID: 's3', verb: 'LEARN',     shelf: 'REFERENCE',  sortOrder: 100, title: 'S3', personaHidden: ['role:developer'] },
];
const forYouCandidates = [
  { ID: 'f1', kind: 'tutorial', targetSlug: 't1', title: 'T1', personaTags: ['role:developer'], personaWeight: 5, sortOrder: 100 },
  { ID: 'f2', kind: 'tutorial', targetSlug: 't2', title: 'T2', personaTags: ['role:developer'], personaWeight: 3, sortOrder: 100 },
  { ID: 'f3', kind: 'tutorial', targetSlug: 't3', title: 'T3', personaTags: ['role:developer'], personaWeight: 1, sortOrder: 100 },
];

describe('buildEnvelope', () => {
  it('has all top-level fields', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates, teaserSlugs: [] });
    for (const k of ['profile','verbOrder','forYou','teaserOrder','shelfOverrides','videoFilterTags','rssFilterTags']) {
      expect(env[k]).toBeDefined();
    }
    expect(env.verbOrder).toHaveLength(6);
  });

  it('includes hidden shelf IDs per verb', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.shelfOverrides.learn?.hidden).toContain('s3');
  });

  it('produces reorder list when persona-weighted entry outranks static sortOrder', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    // Build verb: s1 (weight 10, sort 100) beats s2 (sort 50, no weight) despite sortOrder.
    expect(env.shelfOverrides.build?.reorder).toEqual(['s1', 's2']);
  });

  it('drops For-you when fewer than 3 candidates match', () => {
    const two = forYouCandidates.slice(0, 2);
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: two, teaserSlugs: [] });
    expect(env.forYou).toEqual([]);
  });

  it('videoFilterTags include cloud and btp when profile has cloud', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.videoFilterTags).toEqual(expect.arrayContaining(['aws', 'btp']));
  });

  it('rssFilterTags include role and cloud derivatives', () => {
    const env = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(env.rssFilterTags).toEqual(expect.arrayContaining(['btp-development']));
  });
});

describe('hashEnvelope', () => {
  it('is stable for identical input', () => {
    const a = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    const b = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(hashEnvelope(a)).toBe(hashEnvelope(b));
  });

  it('differs when profile differs', () => {
    const a = buildEnvelope({ profile: dev, shelves, forYouCandidates: [], teaserSlugs: [] });
    const other = { role: 'student', deployment: null, cloud: null };
    const b = buildEnvelope({ profile: other, shelves, forYouCandidates: [], teaserSlugs: [] });
    expect(hashEnvelope(a)).not.toBe(hashEnvelope(b));
  });
});
```

- [ ] **Step 2: Run tests, expect fail**

Run: `npx vitest run test/unit/homepage/personalized-envelope.test.js`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```js
// srv/lib/homepage/personalized-envelope.js
//
// (#763) Compose the personalization envelope from profile + DB rows.
// Design §6, §7.

import crypto from 'node:crypto';
import { rankShelves, rankForYou } from './persona-scoring.js';
import { BASE_ORDER, computeVerbOrder } from './persona-map.js';

const VERBS_UPPER = ['LEARN','BUILD','INTEGRATE','OPERATE','AI','CONNECT'];
const VERB_TO_LOWER = { LEARN:'learn', BUILD:'build', INTEGRATE:'integrate',
                        OPERATE:'operate', AI:'ai', CONNECT:'connect' };

// Cloud-provider fan-out: knowing you're on aws is useful; we always
// include btp too because SAP-first content dominates the corpus.
function deriveVideoFilterTags(profile) {
  const out = [];
  if (profile?.cloud) out.push(profile.cloud);
  if (!out.includes('btp')) out.push('btp');
  return out;
}

// RSS tags are tag-shaped hints matched against blog post categories.
// Keep the map explicit; unknown values contribute nothing.
const ROLE_RSS = {
  developer: ['btp-development'],
  architect: ['architecture'],
  sysadmin:  ['operations'],
  student:   ['getting-started'],
};
const CLOUD_RSS = {
  btp:  ['btp-development'],
  aws:  ['btp-development'],
  azure:['btp-development'],
  gcp:  ['btp-development'],
};

function deriveRssFilterTags(profile) {
  const tags = new Set();
  for (const t of ROLE_RSS[profile?.role] || []) tags.add(t);
  for (const t of CLOUD_RSS[profile?.cloud] || []) tags.add(t);
  return [...tags];
}

// Count how many active shelves per verb match the profile — used by
// computeVerbOrder for the ±1 slot tilt.
function tagCountsPerVerb(shelves, profile) {
  const counts = {};
  for (const s of shelves) {
    const verbKey = VERB_TO_LOWER[s.verb] || String(s.verb || '').toLowerCase();
    if (!verbKey) continue;
    // Only count entries that actually match (positive signal).
    if ((s.personaTags || []).some((t) => {
      const i = t.indexOf(':');
      return i > 0 && profile?.[t.slice(0, i)] === t.slice(i + 1);
    })) {
      counts[verbKey] = (counts[verbKey] || 0) + 1;
    }
  }
  return counts;
}

function buildShelfOverrides(shelves, profile) {
  const overrides = {};
  for (const verbUpper of VERBS_UPPER) {
    const key = VERB_TO_LOWER[verbUpper];
    const rows = shelves.filter((s) => s.verb === verbUpper);
    if (rows.length === 0) continue;

    const staticOrder = [...rows]
      .sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100)
        || String(a.title ?? '').localeCompare(String(b.title ?? '')));

    const rankedIDs = rankShelves(rows, profile).map((r) => r.ID);
    const staticIDs = staticOrder.map((r) => r.ID);
    const hidden = staticIDs.filter((id) => !rankedIDs.includes(id));

    const orderChanged = staticIDs
      .filter((id) => rankedIDs.includes(id))
      .some((id, i) => id !== rankedIDs[i]);

    overrides[key] = {
      reorder: orderChanged ? rankedIDs : [],
      hidden,
    };
  }
  return overrides;
}

export function buildEnvelope({ profile, shelves, forYouCandidates, teaserSlugs }) {
  const p = profile || {};
  const verbOrder = computeVerbOrder(p, tagCountsPerVerb(shelves, p));

  const forYou = rankForYou(forYouCandidates, p, { min: 3, max: 8 })
    .map(({ ID, kind, targetSlug, title, description, imageUrl }) =>
      ({ ID, kind, slug: targetSlug, title, description, imageUrl }));

  const shelfOverrides = buildShelfOverrides(shelves, p);

  return {
    profile: {
      role: p.role ?? null,
      deployment: p.deployment ?? null,
      cloud: p.cloud ?? null,
    },
    verbOrder,
    forYou,
    teaserOrder: [...(teaserSlugs || [])].slice(0, 12),
    shelfOverrides,
    videoFilterTags: deriveVideoFilterTags(p),
    rssFilterTags: deriveRssFilterTags(p),
  };
}

export function hashEnvelope(env) {
  return crypto.createHash('sha1')
    .update(JSON.stringify(env))
    .digest('hex')
    .slice(0, 8);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npx vitest run test/unit/homepage/personalized-envelope.test.js`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/homepage/personalized-envelope.js test/unit/homepage/personalized-envelope.test.js
git commit -m "feat(#763): personalized envelope builder + stable hash"
```

---

## Task 6: Extend `HomepageConfig` with `personalizationEnabled`

**Files:**
- Modify: `db/homepage.cds`
- Modify: `srv/admin-service.js` (auto-init handler — default `personalizationEnabled: false`)
- Test: `test/unit/homepage/homepage-config-personalization-flag.test.js`

**Interfaces:**
- Produces: `HomepageConfig.personalizationEnabled: Boolean default false`. Auto-init handler seeds `false` on first read (surprise-free deploys).

- [ ] **Step 1: Locate the existing auto-init handler**

```bash
grep -n "HomepageConfig" srv/admin-service.js
```

Expected: matches for a before/on-READ handler that inserts a default row when the table is empty (pattern shared with `ChatSettings`, `DisplaySettings`).

- [ ] **Step 2: Write failing test**

```js
// test/unit/homepage/homepage-config-personalization-flag.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('HomepageConfig.personalizationEnabled', () => {
  let model;
  beforeAll(async () => {
    model = await cds.load(['db/schema.cds', 'db/homepage.cds']);
  });

  it('exists as a Boolean default false', () => {
    const cfg = model.definitions['com.sap.developers.ims.HomepageConfig'];
    const el = cfg.elements.personalizationEnabled;
    expect(el).toBeDefined();
    expect(el.type).toBe('cds.Boolean');
    expect(el.default?.val).toBe(false);
  });
});
```

Run: `npx vitest run test/unit/homepage/homepage-config-personalization-flag.test.js`
Expected: FAIL.

- [ ] **Step 3: Extend `HomepageConfig`**

In `db/homepage.cds`, inside `entity HomepageConfig { ... }`, append:

```cds
  // (#763) Kill switch for the personalized-homepage feature.
  // Default false at first migration so a deploy doesn't flip the page
  // for every signed-in user; admin enables via /admin-ui/#homepage.
  personalizationEnabled : Boolean default false;
```

- [ ] **Step 4: Update the auto-init handler seed**

In `srv/admin-service.js`, find the `INSERT.into(HomepageConfig)` call in the auto-init path. Add `personalizationEnabled: false` to the seed row so a freshly deployed DB has an explicit `false` (not NULL).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/homepage/homepage-config-personalization-flag.test.js`
Expected: PASS.

Run: `npx vitest run test/unit/` (broader — catches admin-service test regressions).
Expected: PASS.

- [ ] **Step 6: Regenerate schema snapshot**

Run: `npx cds build --production`
Verify `db/last-dev/` updated.

- [ ] **Step 7: Commit**

```bash
git add db/homepage.cds db/last-dev/ srv/admin-service.js test/unit/homepage/homepage-config-personalization-flag.test.js
git commit -m "feat(#763): HomepageConfig.personalizationEnabled kill switch (default false)"
```

---

## Task 7: `GET /homepage/personalized` — endpoint scaffolding + kill-switch 204

**Files:**
- Modify: `srv/homepage-service.cds`
- Modify: `srv/homepage-service.js`
- Test: `test/integration/homepage/personalized-endpoint.test.js`

**Interfaces:**
- Produces: authenticated function `personalized()` on `HomepageService`. Note the service is currently `@requires: 'any'` — override per-function with `@requires: 'authenticated-user'` on the personalized function; other public functions stay anonymous.
- Response contract per spec §6. `X-Personalization: 1` and `Cache-Control: private, no-store` headers on 200. Kill switch returns 204 with no body.

- [ ] **Step 1: Write failing integration test**

```js
// test/integration/homepage/personalized-endpoint.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('GET /homepage/personalized', () => {
  let srv;
  beforeAll(async () => { srv = await cds.test('.'); });
  afterAll(() => { srv?.server?.close?.(); });

  it('401 without auth', async () => {
    const r = await srv.get('/homepage/personalized');
    expect(r.status).toBe(401);
  });

  it('204 when kill switch is off', async () => {
    await srv.post('/admin/HomepageConfig').send({ personalizationEnabled: false });
    const r = await srv.get('/homepage/personalized').auth('alice', 'password');
    expect(r.status).toBe(204);
  });

  it('200 with envelope when enabled', async () => {
    await srv.post('/admin/HomepageConfig').send({ personalizationEnabled: true });
    const r = await srv.get('/homepage/personalized').auth('alice', 'password');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toContain('no-store');
    expect(r.headers['x-personalization']).toBe('1');
    expect(r.body.hash).toBeDefined();
    expect(r.body.verbOrder).toHaveLength(6);
    expect(r.body.shelfOverrides).toBeDefined();
  });

  it('returns 304 on matching If-None-Match', async () => {
    const first = await srv.get('/homepage/personalized').auth('alice', 'password');
    const etag = first.headers.etag;
    const second = await srv.get('/homepage/personalized')
      .auth('alice', 'password').set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });
});
```

Run: `npx vitest run test/integration/homepage/personalized-endpoint.test.js` — FAIL, function not defined.

- [ ] **Step 2: Extend `srv/homepage-service.cds`**

Inside the service body:

```cds
  type PersonalizedProfile { role: String; deployment: String; cloud: String; }
  type ShelfOverride       { reorder: array of UUID; hidden: array of UUID; }
  type ShelfOverrideMap {
    learn: ShelfOverride; build: ShelfOverride; integrate: ShelfOverride;
    operate: ShelfOverride; ai: ShelfOverride; connect: ShelfOverride;
  }
  type ForYouItem {
    ID: UUID; kind: String; slug: String; title: String;
    description: String; imageUrl: String;
  }
  type PersonalizedEnvelope {
    hash            : String;
    profile         : PersonalizedProfile;
    verbOrder       : array of String;
    forYou          : array of ForYouItem;
    teaserOrder     : array of String;
    shelfOverrides  : ShelfOverrideMap;
    videoFilterTags : array of String;
    rssFilterTags   : array of String;
  }

  @(requires: 'authenticated-user')
  function personalized() returns PersonalizedEnvelope;
```

- [ ] **Step 3: Implement handler in `srv/homepage-service.js`**

Append inside the existing `cds.service.impl`:

```js
const { buildEnvelope, hashEnvelope } = require('./lib/homepage/personalized-envelope');

this.on('personalized', async (req) => {
  const { HomepageShelves, HomepageForYouCandidates, HomepageConfig,
          UserLearningPreferences } = cds.entities('com.sap.developers.ims');

  const cfg = await SELECT.one.from(HomepageConfig).columns('personalizationEnabled');
  if (!cfg?.personalizationEnabled) {
    req.res.status(204).end();
    return req.reject(-1);
  }

  const userId = req.user?.id;
  if (!userId) return req.reject(401, 'authentication required');

  const [prefsRow, shelves, forYou] = await Promise.all([
    SELECT.one.from(UserLearningPreferences).where({ user: userId })
      .columns('deployment', 'role', 'cloud'),
    SELECT.from(HomepageShelves).where({ isActive: true })
      .columns('ID','verb','shelf','sortOrder','title',
               'personaTags','personaWeight','personaHidden'),
    SELECT.from(HomepageForYouCandidates).where({ active: true })
      .columns('ID','kind','targetSlug','title','description','imageUrl',
               'personaTags','personaWeight','personaHidden','sortOrder'),
  ]);

  const profile = {
    role:       prefsRow?.role       ?? null,
    deployment: prefsRow?.deployment ?? null,
    cloud:      prefsRow?.cloud      ?? null,
  };

  const envelope = buildEnvelope({
    profile, shelves, forYouCandidates: forYou, teaserSlugs: [], // Task 12
  });
  envelope.hash = hashEnvelope(envelope);

  const inm = req.req?.headers?.['if-none-match'];
  if (inm && inm.replace(/"/g, '') === envelope.hash) {
    req.res.setHeader('ETag', `"${envelope.hash}"`);
    req.res.status(304).end();
    return req.reject(-1);
  }

  req.res.setHeader('Cache-Control', 'private, no-store');
  req.res.setHeader('X-Personalization', '1');
  req.res.setHeader('ETag', `"${envelope.hash}"`);
  return envelope;
});
```

- [ ] **Step 4: Approuter route**

```bash
grep -n "homepage" approuter/xs-app.json
```

Ensure a route matches `^/homepage/personalized$` with `authenticationType: 'xsuaa'`, placed **above** any public `^/homepage/(.*)` route (first-match wins).

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/integration/homepage/personalized-endpoint.test.js`
Expected: PASS all four.

- [ ] **Step 6: Commit**

```bash
git add srv/homepage-service.cds srv/homepage-service.js approuter/xs-app.json test/integration/homepage/personalized-endpoint.test.js
git commit -m "feat(#763): GET /homepage/personalized endpoint (auth, kill switch, ETag, X-Personalization)"
```

---

## Task 8: Persona-tag save-time validator on admin service

**Files:**
- Modify: `srv/admin-service.cds` (expose new `HomepageShelves` fields; new `HomepageForYouCandidatesAdmin` projection)
- Modify: `srv/admin-service.js` (before-CREATE/UPDATE handler)
- Test: `test/integration/homepage/persona-tag-admin-validation.test.js`

**Interfaces:**
- Consumes: `validateTags` (Task 2).
- Produces: admin write returns 400 with field-level error naming the invalid tags.

- [ ] **Step 1: Expose entities**

Locate the existing `HomepageShelves` projection in `srv/admin-service.cds`. If it uses an explicit column list, add `personaTags, personaWeight, personaHidden`; if `SELECT * from`, no change needed.

Add:
```cds
@odata.draft.enabled
entity HomepageForYouCandidatesAdmin as projection on ims.HomepageForYouCandidates;
```

- [ ] **Step 2: Write failing test**

```js
// test/integration/homepage/persona-tag-admin-validation.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('Admin persona-tag validation', () => {
  let srv;
  beforeAll(async () => { srv = await cds.test('.'); });

  it('rejects unknown persona tag on HomepageShelves CREATE', async () => {
    const r = await srv.post('/admin/HomepageShelves').auth('admin', 'password').send({
      verb: 'BUILD', shelf: 'START_HERE', title: 'X', url: 'https://x',
      personaTags: ['role:manager'],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(String(r.text || JSON.stringify(r.body))).toMatch(/role:manager/);
  });

  it('accepts known tags', async () => {
    const r = await srv.post('/admin/HomepageShelves').auth('admin', 'password').send({
      verb: 'BUILD', shelf: 'START_HERE', title: 'X', url: 'https://x',
      personaTags: ['role:developer', 'cloud:aws'], personaWeight: 5,
    });
    expect(r.status).toBeLessThan(400);
  });
});
```

Run: `npx vitest run test/integration/homepage/persona-tag-admin-validation.test.js` — FAIL.

- [ ] **Step 3: Wire the validator**

In `srv/admin-service.js`:

```js
const { validateTags } = require('./lib/homepage/persona-tag-validator');

function checkPersonaTagsHandler(req) {
  for (const field of ['personaTags', 'personaHidden']) {
    const tags = req.data?.[field];
    if (tags == null) continue;
    const v = validateTags(tags);
    if (!v.ok) {
      req.error({
        code: 'PERSONA_TAG_INVALID',
        message: `Unknown persona tag(s): ${v.invalid.join(', ')}`,
        target: field,
      });
    }
  }
}

// In cds.service.impl body:
const { HomepageShelves, HomepageForYouCandidatesAdmin } = this.entities;
this.before(['CREATE','UPDATE'], HomepageShelves, checkPersonaTagsHandler);
this.before(['CREATE','UPDATE'], HomepageForYouCandidatesAdmin, checkPersonaTagsHandler);
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/integration/homepage/persona-tag-admin-validation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/integration/homepage/persona-tag-admin-validation.test.js
git commit -m "feat(#763): admin service rejects unknown persona tags at save"
```

---

## Task 9: Coordinator island (narrow slice — auth check, fetch, session cache)

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/coordinator.ts`
- Create: `hugo-apps/src/homepage-personalizer/index.ts`
- Create: `hugo-apps/src/homepage-personalizer/session-cache.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/coordinator.test.ts`
- Modify: `hugo-apps/vite.config.ts`

**Interfaces:**
- Produces:
  - `boot(): Promise<void>` — main entry, exported for tests.
  - `readSessionCache()` / `writeSessionCache(env)` — sessionStorage helpers.
  - `isDefaultViewActive(): boolean` — URL `?default=1` OR sessionStorage flag.

For this task, coordinator only fetches and caches — no DOM. Task 10 wires DOM.

- [ ] **Step 1: Write failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/coordinator.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('coordinator boot()', () => {
  beforeEach(() => {
    sessionStorage.clear(); localStorage.clear();
    document.cookie = ''; (globalThis as any).fetch = vi.fn();
  });

  it('early-exits when anon', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 401 });
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('early-exits when session default flag set', async () => {
    sessionStorage.setItem('sap-devs-homepage-default', '1');
    const { boot } = await import('../coordinator');
    await boot();
    const urls = (globalThis.fetch as any).mock.calls.map((c: any) => c[0]);
    expect(urls).not.toContain('/homepage/personalized');
  });

  it('fetches and caches on 200', async () => {
    document.cookie = 'JSESSIONID=abc';
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true, status: 200, json: async () => ({ hash: 'x' }),
    });
    const { boot } = await import('../coordinator');
    await boot();
    const cache = sessionStorage.getItem('sap-devs-homepage-personalized');
    expect(cache).toContain('"hash":"x"');
  });

  it('honours 304 by keeping cached payload', async () => {
    document.cookie = 'JSESSIONID=abc';
    sessionStorage.setItem('sap-devs-homepage-personalized',
      JSON.stringify({ hash: 'x', payload: { hash: 'x', verbOrder: ['a','b'] }, at: Date.now() }));
    (globalThis.fetch as any).mockResolvedValueOnce({ ok: true, status: 304 });
    const { boot } = await import('../coordinator');
    await boot();
    const cached = JSON.parse(sessionStorage.getItem('sap-devs-homepage-personalized')!);
    expect(cached.payload.verbOrder).toEqual(['a','b']);
  });

  it('swallows fetch errors silently', async () => {
    document.cookie = 'JSESSIONID=abc';
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('boom'));
    const { boot } = await import('../coordinator');
    await expect(boot()).resolves.toBeUndefined();
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/coordinator.test.ts` — FAIL.

- [ ] **Step 2: Implement session cache**

```ts
// hugo-apps/src/homepage-personalizer/session-cache.ts
const KEY = 'sap-devs-homepage-personalized';
const TTL_MS = 5 * 60 * 1000;

export interface Envelope {
  hash: string;
  profile?: { role: string|null; deployment: string|null; cloud: string|null };
  verbOrder?: string[];
  forYou?: any[];
  teaserOrder?: string[];
  shelfOverrides?: Record<string, { reorder: string[]; hidden: string[] }>;
  videoFilterTags?: string[];
  rssFilterTags?: string[];
}

interface CacheRow { hash: string; payload: Envelope; at: number; }

export function readSessionCache(): CacheRow | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const row = JSON.parse(raw) as CacheRow;
    if (!row?.hash || !row?.payload) return null;
    if (Date.now() - row.at > TTL_MS) return null;
    return row;
  } catch { return null; }
}

export function writeSessionCache(payload: Envelope): void {
  try {
    const row: CacheRow = { hash: payload.hash, payload, at: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(row));
  } catch { /* quota — silent */ }
}
```

- [ ] **Step 3: Implement coordinator**

```ts
// hugo-apps/src/homepage-personalizer/coordinator.ts
import { readSessionCache, writeSessionCache, type Envelope } from './session-cache';

const DEFAULT_FLAG_KEY = 'sap-devs-homepage-default';
const ENDPOINT = '/homepage/personalized';

export function isDefaultViewActive(): boolean {
  try {
    if (new URLSearchParams(location.search).get('default') === '1') return true;
    return sessionStorage.getItem(DEFAULT_FLAG_KEY) === '1';
  } catch { return false; }
}

function looksSignedIn(): boolean {
  return typeof document !== 'undefined'
    && /(?:^|;\s*)JSESSIONID=/.test(document.cookie || '');
}

async function isSignedIn(): Promise<boolean> {
  if (looksSignedIn()) return true;
  try {
    const r = await fetch('/me', { credentials: 'include' });
    return r.ok;
  } catch { return false; }
}

export async function boot(): Promise<void> {
  try {
    if (isDefaultViewActive()) return;
    if (!(await isSignedIn())) return;

    const cached = readSessionCache();
    const headers: Record<string, string> = {};
    if (cached?.hash) headers['If-None-Match'] = `"${cached.hash}"`;

    const resp = await fetch(ENDPOINT, { credentials: 'include', headers });
    if (resp.status === 204 || resp.status === 401) return;
    if (resp.status === 304) { applyEnvelope(cached!.payload); return; }
    if (!resp.ok) return;

    const payload = (await resp.json()) as Envelope;
    writeSessionCache(payload);
    applyEnvelope(payload);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.debug('[homepage-personalizer] boot failed', e);
  }
}

// Replaced by Task 10 with the surface dispatcher.
function applyEnvelope(_env: Envelope): void { /* Task 10 */ }
```

- [ ] **Step 4: Vite entry**

```ts
// hugo-apps/src/homepage-personalizer/index.ts
import { boot } from './coordinator';

if (document.readyState === 'complete') {
  (window as any).requestIdleCallback
    ? (window as any).requestIdleCallback(() => boot())
    : setTimeout(boot, 50);
} else {
  window.addEventListener('load', () => {
    (window as any).requestIdleCallback
      ? (window as any).requestIdleCallback(() => boot())
      : setTimeout(boot, 50);
  }, { once: true });
}
```

- [ ] **Step 5: Register in `hugo-apps/vite.config.ts`**

Add gzip budget:
```ts
const MAX_HOMEPAGE_PERSONALIZER_GZIP = 12 * 1024;
function homepagePersonalizerBudget() {
  return {
    name: 'homepage-personalizer-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['homepage-personalizer.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_HOMEPAGE_PERSONALIZER_GZIP) {
        // @ts-ignore
        this.error(`homepage-personalizer.js is ${gz} bytes gzipped (> ${MAX_HOMEPAGE_PERSONALIZER_GZIP}).`);
      } else {
        // @ts-ignore
        this.warn(`homepage-personalizer.js: ${gz} bytes gzipped (budget ${MAX_HOMEPAGE_PERSONALIZER_GZIP}).`);
      }
    },
  };
}
```

Add `homepagePersonalizerBudget()` to the plugins array. Add entry:
```ts
'homepage-personalizer': resolve(__dirname, 'src/homepage-personalizer/index.ts'),
```

- [ ] **Step 6: Run tests + build**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/coordinator.test.ts` — PASS.
Run: `cd hugo-apps && npm run build` — succeeds, budget warning shows current size well under 12 KB.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/ hugo-apps/vite.config.ts
git commit -m "feat(#763): personalizer coordinator (auth check, fetch, ETag, session cache)"
```

---

## Task 10: Verb-order surface + Hugo attach + baseof.html script wire-up

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/verb-order.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/verb-order.test.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts`
- Modify: `hugo/layouts/partials/homepage/verb-spine.html`
- Modify: `hugo/layouts/_default/baseof.html`

**Interfaces:**
- Consumes: `Envelope.verbOrder: string[]`
- Produces: `applyVerbOrder(root: HTMLElement | null, order: string[]): void`

- [ ] **Step 1: Add `data-verb` and `data-personalize` markers**

In `hugo/layouts/partials/homepage/verb-spine.html`:
- Ensure each of the six tile elements has `data-verb="learn|build|integrate|operate|ai|connect"` (lowercase — consistent with `computeVerbOrder`).
- Wrap the list in `<section class="verb-spine" data-personalize="verb-order" data-skeleton="verb-spine">`.

- [ ] **Step 2: Write failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/verb-order.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { applyVerbOrder } from '../verb-order';

function setup(order: string[]) {
  document.body.innerHTML = `
    <section data-personalize="verb-order">
      <ul>${order.map(v => `<li data-verb="${v}">${v}</li>`).join('')}</ul>
    </section>`;
  return document.querySelector<HTMLElement>('[data-personalize="verb-order"]')!;
}

describe('applyVerbOrder', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reorders children by data-verb', () => {
    const root = setup(['learn','build','integrate','operate','ai','connect']);
    applyVerbOrder(root, ['build','learn','integrate','ai','operate','connect']);
    const got = [...root.querySelectorAll('li')].map(li => li.getAttribute('data-verb'));
    expect(got).toEqual(['build','learn','integrate','ai','operate','connect']);
  });

  it('is a no-op when order is empty', () => {
    const root = setup(['learn','build','integrate','operate','ai','connect']);
    applyVerbOrder(root, []);
    const got = [...root.querySelectorAll('li')].map(li => li.getAttribute('data-verb'));
    expect(got).toEqual(['learn','build','integrate','operate','ai','connect']);
  });

  it('does not throw when root is null', () => {
    expect(() => applyVerbOrder(null, ['build'])).not.toThrow();
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/verb-order.test.ts` — FAIL.

- [ ] **Step 3: Implement**

```ts
// hugo-apps/src/homepage-personalizer/verb-order.ts
export function applyVerbOrder(root: HTMLElement | null, order: string[]): void {
  if (!root || !order || order.length === 0) return;
  const list = root.querySelector('ul, ol');
  if (!list) return;
  const byVerb = new Map<string, Element>();
  for (const li of list.children) {
    const v = (li as HTMLElement).dataset?.verb;
    if (v) byVerb.set(v, li);
  }
  const seen = new Set<string>();
  const frag = document.createDocumentFragment();
  for (const v of order) {
    const el = byVerb.get(v);
    if (el) { frag.appendChild(el); seen.add(v); }
  }
  for (const [v, el] of byVerb) { if (!seen.has(v)) frag.appendChild(el); }
  list.appendChild(frag);
}
```

- [ ] **Step 4: Wire coordinator**

In `hugo-apps/src/homepage-personalizer/coordinator.ts`, replace the `applyEnvelope` stub:

```ts
import { applyVerbOrder } from './verb-order';

function applyEnvelope(env: Envelope): void {
  applyVerbOrder(
    document.querySelector<HTMLElement>('[data-personalize="verb-order"]'),
    env.verbOrder ?? []
  );
}
```

- [ ] **Step 5: Add script tag in `baseof.html`**

Locate the existing conditional script-tag block (search for `homepage-bands.js` or `homepage-explainers.js` — same pattern). Add:

```go-html-template
{{ if or (eq $pageKind "homepage") (in (slice "verb-learn" "verb-build" "verb-integrate" "verb-operate" "verb-ai" "verb-connect") $pageKind) }}
  <script defer src="/js/homepage-personalizer.js"></script>
{{ end }}
```

- [ ] **Step 6: Run tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/` — PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/verb-order.ts hugo-apps/src/homepage-personalizer/__tests__/verb-order.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo/layouts/partials/homepage/verb-spine.html hugo/layouts/_default/baseof.html
git commit -m "feat(#763): apply verb-order surface + Hugo attach + script wire-up"
```

---

## Task 11: Personalized badge (strip UI, session bypass)

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/personalized-badge.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/personalized-badge.test.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts`
- Modify: `hugo/layouts/index.html`

**Interfaces:**
- Produces: `renderBadge(root: HTMLElement | null, profile, mode: 'personalized'|'default'): void`

- [ ] **Step 1: Add badge slot in `hugo/layouts/index.html`**

Between the hero partial and verb-spine partial:
```html
<div class="personalized-badge-slot" data-testid="personalized-badge-slot" hidden></div>
```

- [ ] **Step 2: Write failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/personalized-badge.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { renderBadge } from '../personalized-badge';

beforeEach(() => {
  document.body.innerHTML = '<div class="personalized-badge-slot" hidden></div>';
});

describe('renderBadge', () => {
  const slot = () => document.querySelector<HTMLElement>('.personalized-badge-slot')!;

  it('renders personalized copy with profile echo', () => {
    renderBadge(slot(), { role: 'developer', deployment: 'cloud', cloud: 'aws' }, 'personalized');
    expect(slot().hidden).toBe(false);
    expect(slot().textContent).toContain('Personalized for you');
    expect(slot().textContent).toContain('developer');
    expect(slot().textContent).toContain('AWS');
    expect(slot().querySelector('a[href="/me/#learning-preferences"]')).toBeTruthy();
    expect(slot().querySelector('a[href="?default=1"]')).toBeTruthy();
  });

  it('omits profile clause when all fields null', () => {
    renderBadge(slot(), { role: null, deployment: null, cloud: null }, 'personalized');
    expect(slot().textContent).toContain('Personalized for you');
    expect(slot().textContent).not.toContain('null');
  });

  it('renders default-view copy in default mode', () => {
    renderBadge(slot(), null, 'default');
    expect(slot().textContent).toContain('Viewing the default homepage');
    expect(slot().textContent).toContain('Personalize again');
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/personalized-badge.test.ts` — FAIL.

- [ ] **Step 3: Implement**

```ts
// hugo-apps/src/homepage-personalizer/personalized-badge.ts
const CLOUD_LABEL: Record<string, string> = {
  btp: 'SAP BTP', aws: 'AWS', azure: 'Microsoft Azure',
  gcp: 'Google Cloud', alibaba: 'Alibaba Cloud',
  oracle: 'Oracle Cloud', ibm: 'IBM Cloud',
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' } as any)[c]);
}

function profileClause(p: { role: string|null; deployment: string|null; cloud: string|null }): string {
  const parts: string[] = [];
  if (p.role) parts.push(p.role);
  if (p.cloud) parts.push(CLOUD_LABEL[p.cloud] || p.cloud.toUpperCase());
  if (p.deployment) parts.push(p.deployment === 'onprem' ? 'on-premise' : p.deployment);
  return parts.join(', ');
}

export function renderBadge(
  root: HTMLElement | null,
  profile: { role: string|null; deployment: string|null; cloud: string|null } | null,
  mode: 'personalized' | 'default'
): void {
  if (!root) return;
  root.hidden = false;
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.classList.add('personalized-badge');

  if (mode === 'default') {
    root.innerHTML =
      `<span aria-hidden="true">✨</span> ` +
      `Viewing the default homepage · ` +
      `<a href="#" data-action="reset-personalize">Personalize again</a>`;
    root.querySelector<HTMLAnchorElement>('[data-action="reset-personalize"]')!
      .addEventListener('click', (e) => {
        e.preventDefault();
        try { sessionStorage.removeItem('sap-devs-homepage-default'); } catch {}
        const url = new URL(location.href);
        url.searchParams.delete('default');
        location.assign(url.toString());
      });
    return;
  }

  const clause = profile ? profileClause(profile) : '';
  const clauseHtml = clause ? ` · ${escapeHtml(clause)} ·` : ' ·';
  root.innerHTML =
    `<span aria-hidden="true">✨</span> ` +
    `Personalized for you${clauseHtml} ` +
    `<a href="/me/#learning-preferences">Adjust</a> · ` +
    `<a href="?default=1">See default</a>`;
}
```

- [ ] **Step 4: Wire coordinator**

```ts
// coordinator.ts
import { renderBadge } from './personalized-badge';

// In boot() — when default-view active, still render the default badge:
if (isDefaultViewActive()) {
  renderBadge(document.querySelector('.personalized-badge-slot'), null, 'default');
  return;
}

// In applyEnvelope(env):
renderBadge(
  document.querySelector('.personalized-badge-slot'),
  env.profile ?? null,
  'personalized'
);
```

- [ ] **Step 5: Run tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/` — PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/personalized-badge.ts hugo-apps/src/homepage-personalizer/__tests__/personalized-badge.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo/layouts/index.html
git commit -m "feat(#763): personalized badge + See default / Personalize again bypass"
```

---

## Task 12: Row-5 tutorial teaser rerank

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/teaser-rerank.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/teaser-rerank.test.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts`
- Modify: `hugo/layouts/partials/homepage/<row-5-partial>.html`
- Modify: `srv/homepage-service.cds` — new function `tutorialCards(slugs: array of String)`
- Modify: `srv/homepage-service.js` — implement handler + supply real `teaserSlugs`
- Test: `test/integration/homepage/tutorial-cards.test.js`

**Interfaces:**
- Produces:
  - `applyTeaserRerank(root, order: string[], fetchMissing: (slugs: string[]) => Promise<FetchedCard[]>): Promise<void>`
  - Backend function `tutorialCards(slugs)` returns `[{ slug, html }, ...]`

- [ ] **Step 1: Locate the Row-5 partial**

```bash
grep -rn "browse.json\|featured\|tutorial-teaser" hugo/layouts/partials/homepage/
```

Confirm the file. Ensure each card outer has `data-slug="{{ .Params.slug }}"` and wrap the card list in `<section data-personalize="teaser-rerank">` with a `.cards` child element containing the cards.

- [ ] **Step 2: Write failing card-rerank test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/teaser-rerank.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { applyTeaserRerank } from '../teaser-rerank';

function setup(slugs: string[]) {
  document.body.innerHTML = `
    <section data-personalize="teaser-rerank">
      <div class="cards">
        ${slugs.map(s => `<article data-slug="${s}">${s}</article>`).join('')}
      </div>
    </section>`;
  return document.querySelector<HTMLElement>('[data-personalize="teaser-rerank"]')!;
}

describe('applyTeaserRerank', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reorders existing cards by slug', async () => {
    const root = setup(['a','b','c']);
    await applyTeaserRerank(root, ['c','a','b'], async () => []);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['c','a','b']);
  });

  it('appends fetched cards for missing slugs', async () => {
    const root = setup(['a','b']);
    const fetchMissing = vi.fn(async () => [
      { slug: 'z', html: '<article data-slug="z">Z</article>' },
    ]);
    await applyTeaserRerank(root, ['a','b','z'], fetchMissing);
    expect(fetchMissing).toHaveBeenCalledWith(['z']);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['a','b','z']);
  });

  it('is a no-op when order is empty', async () => {
    const root = setup(['a','b']);
    await applyTeaserRerank(root, [], async () => []);
    const got = [...root.querySelectorAll('article')].map(a => a.getAttribute('data-slug'));
    expect(got).toEqual(['a','b']);
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/teaser-rerank.test.ts` — FAIL.

- [ ] **Step 3: Implement teaser-rerank**

```ts
// hugo-apps/src/homepage-personalizer/teaser-rerank.ts
export interface FetchedCard { slug: string; html: string; }

export async function applyTeaserRerank(
  root: HTMLElement | null,
  order: string[],
  fetchMissing: (slugs: string[]) => Promise<FetchedCard[]>
): Promise<void> {
  if (!root || !order || order.length === 0) return;
  const list = root.querySelector('.cards') || root;
  const existing = new Map<string, Element>();
  for (const el of Array.from(list.children)) {
    const s = (el as HTMLElement).dataset?.slug;
    if (s) existing.set(s, el);
  }
  const missing = order.filter((s) => !existing.has(s));
  let fetched: FetchedCard[] = [];
  if (missing.length > 0) {
    try { fetched = await fetchMissing(missing); } catch { fetched = []; }
  }
  const parsed = new Map<string, Element>();
  for (const f of fetched) {
    const tpl = document.createElement('template');
    tpl.innerHTML = f.html.trim();
    const el = tpl.content.firstElementChild;
    if (el) parsed.set(f.slug, el);
  }
  const frag = document.createDocumentFragment();
  for (const slug of order) {
    const el = existing.get(slug) || parsed.get(slug);
    if (el) frag.appendChild(el);
  }
  for (const [slug, el] of existing) {
    if (!order.includes(slug)) frag.appendChild(el);
  }
  list.appendChild(frag);
}
```

- [ ] **Step 4: Add `tutorialCards` CAP function**

In `srv/homepage-service.cds`:
```cds
  type TutorialCard { slug: String; html: String; }
  function tutorialCards(slugs: array of String) returns array of TutorialCard;
```

In `srv/homepage-service.js`:
```js
this.on('tutorialCards', async (req) => {
  const raw = req.data?.slugs || [];
  const slugs = raw.filter(Boolean).map(String).slice(0, 20);
  if (slugs.length === 0) return [];
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const rows = await SELECT.from(TutorialMeta).where({ slug: { in: slugs } })
    .columns('slug','title','duration','difficulty','icon');
  const safe = (s) => String(s ?? '').replace(/[&<>"]/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' })[c]);
  return rows.map((r) => ({
    slug: r.slug,
    html: `<article data-slug="${safe(r.slug)}" class="tutorial-card">` +
          `<h3>${safe(r.title)}</h3>` +
          `<span class="meta">${safe(r.difficulty)} · ${safe(r.duration)}</span>` +
          `</article>`,
  }));
});
```

- [ ] **Step 5: Wire teaser slugs into the envelope**

Update the `personalized` handler — replace `teaserSlugs: []`:

```js
const { TutorialMeta } = cds.entities('com.sap.developers.ims');
// The "featured" flag name below is a placeholder; verify the actual
// flag/query the current Row 5 uses (check scripts/build-browse-json.ts
// or the row-5 Hugo data source) and swap in the equivalent read.
const staticTop = await SELECT.from(TutorialMeta)
  .where({ isFeatured: true }).columns('slug').limit(8);
const staticSlugs = staticTop.map((r) => r.slug);
const featuredForYou = forYou
  .filter((f) => f.kind === 'tutorial')
  .map((f) => f.targetSlug);
const teaserSlugs = [...new Set([...staticSlugs, ...featuredForYou])].slice(0, 12);
// then pass into buildEnvelope: teaserSlugs
```

If `TutorialMeta` has no `isFeatured`, replace with whatever selection Row 5 already uses (grep `scripts/build-browse-json` or `hugo/data/browse.json` source).

- [ ] **Step 6: Wire coordinator**

```ts
// coordinator.ts
import { applyTeaserRerank } from './teaser-rerank';

async function fetchMissingCards(slugs: string[]): Promise<{slug:string;html:string}[]> {
  try {
    const url = `/homepage/tutorialCards?slugs=${encodeURIComponent(JSON.stringify(slugs))}`;
    const r = await fetch(url, { credentials: 'include' });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}

// Inside applyEnvelope():
void applyTeaserRerank(
  document.querySelector<HTMLElement>('[data-personalize="teaser-rerank"]'),
  env.teaserOrder ?? [],
  fetchMissingCards
);
```

- [ ] **Step 7: Run all tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/` — PASS.
Run: `npx vitest run test/integration/homepage/personalized-endpoint.test.js` — PASS (envelope still shape-valid).

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/teaser-rerank.ts hugo-apps/src/homepage-personalizer/__tests__/teaser-rerank.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo/layouts/partials/homepage/ srv/homepage-service.cds srv/homepage-service.js
git commit -m "feat(#763): teaser-rerank surface + tutorialCards endpoint for missing slugs"
```

---

## Task 13: For-you row (Row 2b)

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/for-you-row.vue`
- Create: `hugo-apps/src/homepage-personalizer/mount-for-you.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/for-you-row.test.ts`
- Create: `hugo/layouts/partials/homepage/for-you.html`
- Modify: `hugo/layouts/index.html`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts`

**Interfaces:**
- Produces: `mountForYou(root: HTMLElement | null, items: ForYouItem[]): void` — mounts Vue app when `items.length >= 3`; unhides section; stays hidden otherwise.

- [ ] **Step 1: Create the empty slot**

`hugo/layouts/partials/homepage/for-you.html`:
```html
<section class="for-you-row" data-personalize="for-you" hidden aria-labelledby="for-you-heading">
  <h2 id="for-you-heading" class="sr-only">For you</h2>
</section>
```

In `hugo/layouts/index.html`, insert `{{ partial "homepage/for-you.html" . }}` between the verb-spine include and the events-band include.

- [ ] **Step 2: Write failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/for-you-row.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mountForYou } from '../mount-for-you';

beforeEach(() => {
  document.body.innerHTML = '<section class="for-you-row" data-personalize="for-you" hidden></section>';
});

describe('mountForYou', () => {
  const root = () => document.querySelector<HTMLElement>('[data-personalize="for-you"]')!;

  it('stays hidden with fewer than 3 items', () => {
    mountForYou(root(), [
      { ID:'1', kind:'tutorial', slug:'a', title:'A', description:'', imageUrl:'' },
      { ID:'2', kind:'tutorial', slug:'b', title:'B', description:'', imageUrl:'' },
    ]);
    expect(root().hidden).toBe(true);
  });

  it('renders and unhides with 3+ items', () => {
    mountForYou(root(), [
      { ID:'1', kind:'tutorial', slug:'a', title:'A', description:'', imageUrl:'' },
      { ID:'2', kind:'tutorial', slug:'b', title:'B', description:'', imageUrl:'' },
      { ID:'3', kind:'tutorial', slug:'c', title:'C', description:'', imageUrl:'' },
    ]);
    expect(root().hidden).toBe(false);
    expect(root().querySelectorAll('a').length).toBe(3);
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/for-you-row.test.ts` — FAIL.

- [ ] **Step 3: Vue component**

```vue
<!-- hugo-apps/src/homepage-personalizer/for-you-row.vue -->
<template>
  <ul class="for-you-cards">
    <li v-for="item in items" :key="item.ID">
      <a :href="linkFor(item)">
        <img v-if="item.imageUrl" :src="item.imageUrl" alt="" />
        <h3>{{ item.title }}</h3>
        <p v-if="item.description">{{ item.description }}</p>
        <span class="kind">{{ item.kind }}</span>
      </a>
    </li>
  </ul>
</template>
<script setup lang="ts">
interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}
defineProps<{ items: ForYouItem[] }>();
function linkFor(it: ForYouItem): string {
  switch (it.kind) {
    case 'tutorial': return `/tutorials/${it.slug}/`;
    case 'mission':  return `/missions/${it.slug}/`;
    case 'blog':     return it.slug.startsWith('http') ? it.slug : `/blog/${it.slug}/`;
    case 'video':    return it.slug.startsWith('http') ? it.slug : `https://youtu.be/${it.slug}`;
    default:         return it.slug;
  }
}
</script>
```

- [ ] **Step 4: Mount helper**

```ts
// hugo-apps/src/homepage-personalizer/mount-for-you.ts
import { createApp } from 'vue';
import ForYouRow from './for-you-row.vue';

interface ForYouItem {
  ID: string; kind: string; slug: string; title: string;
  description: string; imageUrl: string;
}

export function mountForYou(root: HTMLElement | null, items: ForYouItem[]): void {
  if (!root) return;
  if (!items || items.length < 3) { root.hidden = true; return; }
  root.hidden = false;
  let target = root.querySelector<HTMLElement>('[data-vue-root]');
  if (!target) {
    target = document.createElement('div');
    target.setAttribute('data-vue-root', '');
    root.appendChild(target);
  }
  createApp(ForYouRow, { items }).mount(target);
}
```

- [ ] **Step 5: Wire coordinator**

```ts
// coordinator.ts
import { mountForYou } from './mount-for-you';

// Inside applyEnvelope():
mountForYou(
  document.querySelector<HTMLElement>('[data-personalize="for-you"]'),
  env.forYou ?? []
);
```

- [ ] **Step 6: Run tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/` — PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/for-you-row.vue hugo-apps/src/homepage-personalizer/mount-for-you.ts hugo-apps/src/homepage-personalizer/__tests__/for-you-row.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo/layouts/partials/homepage/for-you.html hugo/layouts/index.html
git commit -m "feat(#763): For-you row (Row 2b) with min-3-items gate"
```

---

## Task 14: Verb sub-page shelf-rerank

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/shelf-rerank.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/shelf-rerank.test.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts`
- Modify: `hugo/layouts/verb/list.html`

**Interfaces:**
- Produces: `applyShelfRerank(overrides, currentVerb?: string): void`

- [ ] **Step 1: Mark verb sub-page shelves**

In `hugo/layouts/verb/list.html`, mark each shelf container:
```html
<section data-personalize="shelf-rerank" data-verb="{{ .Params.verb | lower }}" data-shelf="{{ $shelfKey | lower }}">
  <ul>
    {{ range .entries }}
      <li data-shelf-entry-id="{{ .ID }}"> ... </li>
    {{ end }}
  </ul>
</section>
```

- [ ] **Step 2: Failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/shelf-rerank.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { applyShelfRerank } from '../shelf-rerank';

beforeEach(() => {
  document.body.innerHTML = `
    <section data-personalize="shelf-rerank" data-verb="learn" data-shelf="start_here">
      <ul>
        <li data-shelf-entry-id="e1">E1</li>
        <li data-shelf-entry-id="e2">E2</li>
        <li data-shelf-entry-id="e3">E3</li>
      </ul>
    </section>`;
});

describe('applyShelfRerank', () => {
  it('reorders entries', () => {
    applyShelfRerank({ learn: { reorder: ['e3','e1','e2'], hidden: [] } }, 'learn');
    const got = [...document.querySelectorAll('li')].map(li => li.getAttribute('data-shelf-entry-id'));
    expect(got).toEqual(['e3','e1','e2']);
  });

  it('hides entries listed in hidden', () => {
    applyShelfRerank({ learn: { reorder: [], hidden: ['e2'] } }, 'learn');
    expect(document.querySelector<HTMLElement>('[data-shelf-entry-id="e2"]')!.hidden).toBe(true);
  });

  it('does nothing when currentVerb differs', () => {
    applyShelfRerank({ learn: { reorder: ['e3','e1','e2'], hidden: [] } }, 'build');
    const got = [...document.querySelectorAll('li')].map(li => li.getAttribute('data-shelf-entry-id'));
    expect(got).toEqual(['e1','e2','e3']);
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/shelf-rerank.test.ts` — FAIL.

- [ ] **Step 3: Implement**

```ts
// hugo-apps/src/homepage-personalizer/shelf-rerank.ts
type Overrides = Record<string, { reorder: string[]; hidden: string[] }>;

function detectCurrentVerb(): string | null {
  const el = document.querySelector<HTMLElement>('[data-page-kind]')
    ?? document.documentElement;
  const kind = (el as HTMLElement).dataset?.pageKind || '';
  const m = /^verb-(.+)$/.exec(kind);
  return m ? m[1] : null;
}

export function applyShelfRerank(overrides: Overrides | undefined, currentVerb?: string): void {
  if (!overrides) return;
  const verb = currentVerb ?? detectCurrentVerb();
  if (!verb) return;
  const ov = overrides[verb];
  if (!ov) return;

  const sections = document.querySelectorAll<HTMLElement>(
    `[data-personalize="shelf-rerank"][data-verb="${verb}"]`
  );
  for (const section of sections) {
    const list = section.querySelector('ul, ol');
    if (!list) continue;

    for (const id of ov.hidden || []) {
      const el = list.querySelector<HTMLElement>(`[data-shelf-entry-id="${id}"]`);
      if (el) el.hidden = true;
    }

    if (ov.reorder && ov.reorder.length > 0) {
      const byId = new Map<string, Element>();
      for (const li of Array.from(list.children)) {
        const id = (li as HTMLElement).dataset?.shelfEntryId;
        if (id) byId.set(id, li);
      }
      const seen = new Set<string>();
      const frag = document.createDocumentFragment();
      for (const id of ov.reorder) {
        const el = byId.get(id);
        if (el) { frag.appendChild(el); seen.add(id); }
      }
      for (const [id, el] of byId) { if (!seen.has(id)) frag.appendChild(el); }
      list.appendChild(frag);
    }
  }
}
```

- [ ] **Step 4: Wire coordinator**

```ts
// coordinator.ts
import { applyShelfRerank } from './shelf-rerank';

// Inside applyEnvelope():
applyShelfRerank(env.shelfOverrides);
```

- [ ] **Step 5: Run tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/shelf-rerank.test.ts` — PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/shelf-rerank.ts hugo-apps/src/homepage-personalizer/__tests__/shelf-rerank.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo/layouts/verb/list.html
git commit -m "feat(#763): shelf-rerank surface for verb sub-pages"
```

---

## Task 15: Video-band and RSS filter modules

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/video-filter.ts`
- Create: `hugo-apps/src/homepage-personalizer/rss-filter.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/filters.test.ts`
- Modify: `hugo-apps/src/homepage-bands/VideoBand.vue`
- Modify: `hugo-apps/src/homepage-bands/CommunityLane.vue`

**Interfaces:**
- Produces:
  - `applyVideoFilter(items: VideoItem[], tags: string[]): VideoItem[]` — pure fn; matches float up, non-matches trail; never empties the array.
  - `applyRssFilter(items: RssItem[], tags: string[]): RssItem[]` — same shape for community + news feeds.

- [ ] **Step 1: Read the current VideoBand fetch shape**

```bash
grep -n "videoId\|title\|tags" hugo-apps/src/homepage-bands/VideoBand.vue | head -20
```

Note the exact item field names — filters must reference them exactly.

- [ ] **Step 2: Write failing filter tests**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/filters.test.ts
import { describe, it, expect } from 'vitest';
import { applyVideoFilter } from '../video-filter';
import { applyRssFilter } from '../rss-filter';

describe('applyVideoFilter', () => {
  const items = [
    { videoId: 'a', title: 'BTP intro', tags: ['btp'] },
    { videoId: 'b', title: 'AWS deep dive', tags: ['aws'] },
    { videoId: 'c', title: 'Something else', tags: [] },
  ];
  it('passes through when tags empty', () => {
    expect(applyVideoFilter(items, []).map(x => x.videoId)).toEqual(['a','b','c']);
  });
  it('floats matches to the top, preserves non-matches at the tail', () => {
    expect(applyVideoFilter(items, ['aws']).map(x => x.videoId)).toEqual(['b','a','c']);
  });
  it('is stable across multiple matching tags', () => {
    expect(applyVideoFilter(items, ['aws','btp']).map(x => x.videoId)).toEqual(['a','b','c']);
  });
  it('handles missing tags field gracefully', () => {
    const noTags = [{ videoId: 'x', title: 'X' }] as any[];
    expect(applyVideoFilter(noTags, ['aws']).map(x => x.videoId)).toEqual(['x']);
  });
});

describe('applyRssFilter', () => {
  const items = [
    { title: 'BTP dev', link: '1', categories: ['btp-development'] },
    { title: 'Arch', link: '2', categories: ['architecture'] },
    { title: 'Random', link: '3', categories: [] },
  ];
  it('floats matches on categories', () => {
    expect(applyRssFilter(items as any, ['architecture']).map(x => x.link)).toEqual(['2','1','3']);
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/filters.test.ts` — FAIL.

- [ ] **Step 3: Implement filters**

```ts
// hugo-apps/src/homepage-personalizer/video-filter.ts
interface VideoItem { videoId: string; title?: string; tags?: string[]; [k: string]: any; }

export function applyVideoFilter(items: VideoItem[], tags: string[]): VideoItem[] {
  if (!items?.length || !tags?.length) return items || [];
  const wants = new Set(tags.map((t) => t.toLowerCase()));
  const hit: VideoItem[] = [];
  const miss: VideoItem[] = [];
  for (const it of items) {
    const its = (it.tags || []).map((t: string) => String(t).toLowerCase());
    (its.some((t) => wants.has(t)) ? hit : miss).push(it);
  }
  return [...hit, ...miss];
}
```

```ts
// hugo-apps/src/homepage-personalizer/rss-filter.ts
interface RssItem { title: string; link: string; categories?: string[]; [k: string]: any; }

export function applyRssFilter(items: RssItem[], tags: string[]): RssItem[] {
  if (!items?.length || !tags?.length) return items || [];
  const wants = new Set(tags.map((t) => t.toLowerCase()));
  const hit: RssItem[] = [];
  const miss: RssItem[] = [];
  for (const it of items) {
    const its = (it.categories || []).map((t: string) => String(t).toLowerCase());
    (its.some((t) => wants.has(t)) ? hit : miss).push(it);
  }
  return [...hit, ...miss];
}
```

- [ ] **Step 4: Wire into existing bands**

In `hugo-apps/src/homepage-bands/VideoBand.vue`, after the existing fetch populates `recent`:
```ts
import { applyVideoFilter } from '../homepage-personalizer/video-filter';
// After the fetch that sets recent:
const raw = /* the existing videos array */;
const cached = (() => {
  try { return JSON.parse(sessionStorage.getItem('sap-devs-homepage-personalized') || 'null'); }
  catch { return null; }
})();
const tags: string[] = cached?.payload?.videoFilterTags || [];
recent.value = applyVideoFilter(raw, tags);
```

Do the equivalent in `hugo-apps/src/homepage-bands/CommunityLane.vue` for the community blog list, using `rssFilterTags`.

**Belt-and-braces:** the filter reads sessionStorage rather than being pushed by the coordinator, because the bands' own fetches complete independently. When the coordinator's payload isn't cached yet (first cold visit), `tags` is `[]` and the filter is a passthrough — no race.

- [ ] **Step 5: Run tests**

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/filters.test.ts` — PASS.
Run existing homepage-bands tests to make sure nothing regressed:
Run: `cd hugo-apps && npx vitest run src/homepage-bands/` — PASS.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/video-filter.ts hugo-apps/src/homepage-personalizer/rss-filter.ts hugo-apps/src/homepage-personalizer/__tests__/filters.test.ts hugo-apps/src/homepage-bands/VideoBand.vue hugo-apps/src/homepage-bands/CommunityLane.vue
git commit -m "feat(#763): video + RSS soft filter modules; existing bands opt in"
```

---

## Task 16: BroadcastChannel live re-render + LearningPreferences broadcast

**Files:**
- Create: `hugo-apps/src/homepage-personalizer/prefs-broadcast.ts`
- Create: `hugo-apps/src/homepage-personalizer/__tests__/prefs-broadcast.test.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts` (subscribe)
- Modify: `hugo-apps/src/me/LearningPreferences.vue` (broadcast on save)

**Interfaces:**
- Produces:
  - `subscribeBroadcast(currentHash: string, onNew: (env: Envelope) => void): () => void` — subscribes to `BroadcastChannel('sap-devs-prefs')` + `window.storage` fallback. Returns unsubscribe.
  - `broadcastPreferencesChanged(): void` — called by `LearningPreferences.onSave`.

- [ ] **Step 1: Write failing test**

```ts
// hugo-apps/src/homepage-personalizer/__tests__/prefs-broadcast.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

class FakeChannel {
  static instances: FakeChannel[] = [];
  listeners: ((e: MessageEvent) => void)[] = [];
  constructor(public name: string) { FakeChannel.instances.push(this); }
  addEventListener(_: string, cb: any) { this.listeners.push(cb); }
  postMessage(data: any) {
    for (const c of FakeChannel.instances) if (c !== this) {
      for (const l of c.listeners) l({ data } as MessageEvent);
    }
  }
  close() {}
}

beforeEach(() => {
  FakeChannel.instances = [];
  (globalThis as any).BroadcastChannel = FakeChannel;
  sessionStorage.clear();
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ hash: 'new-hash', verbOrder: ['build'] }),
  });
});

describe('prefs-broadcast', () => {
  it('re-fetches and calls onNew when new hash differs', async () => {
    const { subscribeBroadcast, broadcastPreferencesChanged } = await import('../prefs-broadcast');
    const onNew = vi.fn();
    subscribeBroadcast('old-hash', onNew);
    broadcastPreferencesChanged();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onNew).toHaveBeenCalled();
    expect(onNew.mock.calls[0][0].hash).toBe('new-hash');
  });

  it('no-ops when new hash matches (payload-hash guard)', async () => {
    (globalThis.fetch as any).mockResolvedValue({
      ok: true, status: 200, json: async () => ({ hash: 'same' }),
    });
    const { subscribeBroadcast, broadcastPreferencesChanged } = await import('../prefs-broadcast');
    const onNew = vi.fn();
    subscribeBroadcast('same', onNew);
    broadcastPreferencesChanged();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(onNew).not.toHaveBeenCalled();
  });
});
```

Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/__tests__/prefs-broadcast.test.ts` — FAIL.

- [ ] **Step 2: Implement**

```ts
// hugo-apps/src/homepage-personalizer/prefs-broadcast.ts
import { writeSessionCache, type Envelope } from './session-cache';

const CH_NAME = 'sap-devs-prefs';
const STORAGE_KEY = 'sap-devs-prefs-touched';
const ENDPOINT = '/homepage/personalized';
const MSG = { type: 'preferences-changed' } as const;

export function broadcastPreferencesChanged(): void {
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(CH_NAME);
      ch.postMessage(MSG);
      ch.close();
    }
  } catch { /* silent */ }
  try { localStorage.setItem(STORAGE_KEY, String(Date.now())); } catch {}
}

export function subscribeBroadcast(
  currentHash: string,
  onNew: (env: Envelope) => void
): () => void {
  const cleanups: (() => void)[] = [];

  async function refetch() {
    try {
      const r = await fetch(ENDPOINT, { credentials: 'include' });
      if (!r.ok) return;
      const next = (await r.json()) as Envelope;
      if (!next?.hash || next.hash === currentHash) return;
      writeSessionCache(next);
      currentHash = next.hash;
      onNew(next);
    } catch { /* silent */ }
  }

  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(CH_NAME);
    const handler = (e: MessageEvent) => {
      if ((e as any).data?.type === 'preferences-changed') void refetch();
    };
    ch.addEventListener('message', handler);
    cleanups.push(() => { try { ch.close(); } catch {} });
  }

  const storageHandler = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) void refetch();
  };
  window.addEventListener('storage', storageHandler);
  cleanups.push(() => window.removeEventListener('storage', storageHandler));

  return () => cleanups.forEach((f) => f());
}
```

- [ ] **Step 3: Wire coordinator**

At the end of `applyEnvelope` (or in `boot` after the successful hydrate):

```ts
import { subscribeBroadcast } from './prefs-broadcast';

// After applyEnvelope(payload):
subscribeBroadcast(payload.hash, (next) => applyEnvelope(next));
```

- [ ] **Step 4: Wire LearningPreferences.onSave**

In `hugo-apps/src/me/LearningPreferences.vue`, at the end of the successful `onSave` path (after `status.value = 'saved'`), add:

```ts
import { broadcastPreferencesChanged } from '../homepage-personalizer/prefs-broadcast';
// ...
try { broadcastPreferencesChanged(); } catch {}
```

- [ ] **Step 5: Run all tests**

Run: `cd hugo-apps && npx vitest run` — PASS everything.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/homepage-personalizer/prefs-broadcast.ts hugo-apps/src/homepage-personalizer/__tests__/prefs-broadcast.test.ts hugo-apps/src/homepage-personalizer/coordinator.ts hugo-apps/src/me/LearningPreferences.vue
git commit -m "feat(#763): live cross-tab re-render (BroadcastChannel + storage fallback)"
```

---

## Task 17: Admin UI — Personalization facet on `HomepageShelves`

**Files:**
- Modify: `app/admin-annotations.cds`

**Interfaces:**
- Produces: a new UI facet on the `HomepageShelves` object page named "Personalization", exposing `personaTags`, `personaWeight`, `personaHidden`. Multi-value fields render as `<ui5-multi-combobox>`-style multi-inputs; weight as a numeric input (a slider isn't a Fiori-native pattern for `Integer` — a bounded number field with min/max is acceptable and matches the spec's spirit).

- [ ] **Step 1: Locate existing facets**

```bash
grep -n "HomepageShelves\|Facets\|@UI.Facets" app/admin-annotations.cds | head -30
```

Note the existing `@UI.Facets` block for `HomepageShelves` (the Explainer facet added by #759 lives here).

- [ ] **Step 2: Add fieldgroup + facet**

Append inside the annotations block for `HomepageShelves`:

```cds
annotate AdminService.HomepageShelves with @(
  UI.FieldGroup #Personalization: {
    Data: [
      { Value: personaTags,   Label: 'Persona tags (positive)' },
      { Value: personaWeight, Label: 'Persona weight' },
      { Value: personaHidden, Label: 'Persona hidden (exclude)' },
    ]
  },
);

annotate AdminService.HomepageShelves with @(
  UI.Facets: [
    // ... existing facets stay in place ...
    { $Type: 'UI.ReferenceFacet',
      ID: 'PersonalizationFacet',
      Label: 'Personalization',
      Target: '@UI.FieldGroup#Personalization',
    },
  ]
);
```

If the existing `@UI.Facets` is a single-shot literal (not extended), replace it wholesale — copy the existing facet list, insert `PersonalizationFacet` between Explainer and Link health.

- [ ] **Step 3: Add value-list annotations for tag fields**

```cds
annotate AdminService.HomepageShelves with {
  personaTags @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaTags, ValueListProperty: 'tag' }]
  };
  personaHidden @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaHidden, ValueListProperty: 'tag' }]
  };
};
```

- [ ] **Step 4: Add `PersonaTagChoices` value-help entity**

In `srv/admin-service.cds`, add an unbound function-like value-help entity — the CAP-standard pattern is to project it from an in-memory source. Simplest form:

```cds
entity PersonaTagChoices {
  key tag : String(40);
}
```

Wire the source in `srv/admin-service.js`:
```js
const { KNOWN_TAGS } = require('./lib/homepage/persona-tag-validator');
this.on('READ', 'PersonaTagChoices', () => KNOWN_TAGS.map((tag) => ({ tag })));
```

- [ ] **Step 5: Manually verify in `/admin-ui/#homepage`**

Boot the admin locally:
```bash
cds watch
```
Open `http://localhost:4004/admin-ui/#homepage`. Open any `HomepageShelves` row's object page. Confirm the Personalization facet appears with three fields, and typing in `personaTags` shows the suggestion list drawn from `KNOWN_TAGS`.

- [ ] **Step 6: Commit**

```bash
git add app/admin-annotations.cds srv/admin-service.cds srv/admin-service.js
git commit -m "feat(#763): admin UI Personalization facet on HomepageShelves + PersonaTagChoices value help"
```

---

## Task 18: Admin UI — `HomepageForYouCandidates` list report + object page

**Files:**
- Modify: `app/admin-annotations.cds`
- Modify: `app/admin-shell/` — register a new Fiori Elements route/component for `/admin-ui/#for-you`

**Interfaces:**
- Produces: A new admin route at `/admin-ui/#for-you` showing a list report + object page for `HomepageForYouCandidates`, with the same Personalization facet pattern as Task 17.

- [ ] **Step 1: Add list report + object page annotations**

Append to `app/admin-annotations.cds`:

```cds
annotate AdminService.HomepageForYouCandidatesAdmin with @(
  UI.LineItem: [
    { Value: title,      Label: 'Title' },
    { Value: kind,       Label: 'Kind' },
    { Value: targetSlug, Label: 'Target' },
    { Value: personaTags,   Label: 'Persona tags' },
    { Value: personaWeight, Label: 'Weight' },
    { Value: active,        Label: 'Active' },
    { Value: sortOrder,     Label: 'Sort' },
    { Value: modifiedAt,    Label: 'Updated' },
  ],
  UI.HeaderInfo: {
    TypeName: 'For-you candidate',
    TypeNamePlural: 'For-you candidates',
    Title: { Value: title },
    Description: { Value: kind },
  },
  UI.FieldGroup #Main: {
    Data: [
      { Value: kind },
      { Value: targetSlug },
      { Value: title },
      { Value: description },
      { Value: imageUrl },
      { Value: sortOrder },
      { Value: active },
    ]
  },
  UI.FieldGroup #Personalization: {
    Data: [
      { Value: personaTags,   Label: 'Persona tags (positive)' },
      { Value: personaWeight, Label: 'Persona weight' },
      { Value: personaHidden, Label: 'Persona hidden (exclude)' },
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'MainFacet',           Label: 'General',
      Target: '@UI.FieldGroup#Main' },
    { $Type: 'UI.ReferenceFacet', ID: 'PersonalizationFacet', Label: 'Personalization',
      Target: '@UI.FieldGroup#Personalization' },
  ],
);

annotate AdminService.HomepageForYouCandidatesAdmin with {
  personaTags   @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaTags, ValueListProperty: 'tag' }]
  };
  personaHidden @Common.ValueList: {
    CollectionPath: 'PersonaTagChoices',
    Parameters: [{ $Type: 'Common.ValueListParameterInOut',
                   LocalDataProperty: personaHidden, ValueListProperty: 'tag' }]
  };
};
```

- [ ] **Step 2: Register the admin route**

The admin shell (`app/admin-shell/`) mounts componentUsages by hash — inspect the existing registrations:
```bash
grep -rn "homepage\|componentUsages" app/admin-shell/ | head -20
```

Follow the same pattern (usually a manifest.json navigation section + a `for-you` folder under `app/admin/`) to register `#for-you`.

- [ ] **Step 3: Manual verify**

`cds watch`; open `/admin-ui/#for-you`. Confirm list report loads; create a candidate; verify the Personalization facet works; save; verify a record exists.

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds app/admin-shell/ app/admin/
git commit -m "feat(#763): admin UI list+object pages for HomepageForYouCandidates"
```

---

## Task 19: Skeletons (CSS) + link-health job extension + observability metrics

**Files:**
- Modify: `hugo/assets/scss/homepage.scss` (or the equivalent SCSS file — find with `grep -rn "verb-spine" hugo/assets/`)
- Modify: `srv/jobs/homepage-link-health.js`
- Modify: `srv/lib/observability.js` (or wherever `metrics` lives — locate with `grep -n "metrics" srv/homepage-service.js`)
- Modify: `srv/homepage-service.js` (emit request metric)
- Create: `hugo-apps/src/homepage-personalizer/beacon.ts`
- Modify: `hugo-apps/src/homepage-personalizer/coordinator.ts` (emit applied metric)
- Test: `test/unit/jobs/homepage-link-health-for-you.test.js`

**Interfaces:**
- CSS: sizes each `[data-personalize]` slot to prevent CLS during hydration.
- `homepage-link-health.js`: same HEAD-request loop, now also over `HomepageForYouCandidates.targetSlug`-resolved URLs.
- `metrics.recordCounter('homepage.personalized.requests', { result })` — emitted by the endpoint.
- `beacon.ts`: `beaconApplied(surface: string)` — one `navigator.sendBeacon` per surface per session.

- [ ] **Step 1: Add skeleton CSS**

Locate the homepage stylesheet. Add:
```scss
[data-personalize] {
  min-height: 1px; // baseline
}
[data-personalize="verb-order"] { min-height: 240px; }
[data-personalize="for-you"][hidden] { display: none; }
[data-personalize="for-you"] { min-height: 200px; }
[data-personalize="teaser-rerank"] { min-height: 320px; }
.personalized-badge-slot { min-height: 32px; padding: .25rem .5rem; }
.personalized-badge { display: flex; gap: .5em; align-items: center; }
```

- [ ] **Step 2: Extend link-health job**

Read `srv/jobs/homepage-link-health.js`. Duplicate the shelf-URL loop for `HomepageForYouCandidates`:

```js
// (#763) Also health-check For-you candidate targets.
const { HomepageForYouCandidates } = cds.entities('com.sap.developers.ims');
const fyRows = await SELECT.from(HomepageForYouCandidates).where({ active: true })
  .columns('ID','kind','targetSlug');
// Resolve targetSlug → URL by kind:
//   tutorial → /tutorials/<slug>/
//   mission  → /missions/<slug>/
//   blog|video → assume slug is a URL (external)
//   shelf    → look up HomepageShelves.url by ID and reuse
// HEAD each, write linkStatus + lastChecked back to HomepageForYouCandidates.
```

Write a small helper and reuse the existing HEAD + timeout + concurrency logic.

- [ ] **Step 3: Write failing job test**

```js
// test/unit/jobs/homepage-link-health-for-you.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveForYouUrl } from '../../../srv/jobs/homepage-link-health.js';

describe('resolveForYouUrl', () => {
  it('resolves tutorial kind', () => {
    expect(resolveForYouUrl({ kind: 'tutorial', targetSlug: 'foo' })).toBe('/tutorials/foo/');
  });
  it('resolves mission kind', () => {
    expect(resolveForYouUrl({ kind: 'mission', targetSlug: 'bar' })).toBe('/missions/bar/');
  });
  it('passes URL through for blog/video', () => {
    expect(resolveForYouUrl({ kind: 'blog', targetSlug: 'https://x' })).toBe('https://x');
    expect(resolveForYouUrl({ kind: 'video', targetSlug: 'abc123' })).toBe('https://youtu.be/abc123');
  });
});
```

Extract `resolveForYouUrl` as an exported helper (module `srv/jobs/homepage-link-health.js` should now export it alongside the job entry). Run test — expect PASS.

- [ ] **Step 4: Emit request metric**

In `srv/homepage-service.js` `personalized` handler, after each early-exit and at the end, call:
```js
const metrics = require('./lib/observability');
// on 204:
metrics.recordCounter('homepage.personalized.requests', { result: '204-disabled' });
// on 401:
metrics.recordCounter('homepage.personalized.requests', { result: '401' });
// on 304:
metrics.recordCounter('homepage.personalized.requests', { result: '304' });
// on 200:
metrics.recordCounter('homepage.personalized.requests', { result: '200' });
```

If the observability module uses a different signature, follow that — `grep -n "recordCounter\|metrics\." srv/homepage-service.js` for the local pattern.

- [ ] **Step 5: Beacon**

```ts
// hugo-apps/src/homepage-personalizer/beacon.ts
const KEY = 'sap-devs-homepage-beaconed';
export function beaconApplied(surface: string): void {
  try {
    const set = new Set<string>(JSON.parse(sessionStorage.getItem(KEY) || '[]'));
    if (set.has(surface)) return;
    set.add(surface);
    sessionStorage.setItem(KEY, JSON.stringify([...set]));
    if (typeof navigator?.sendBeacon === 'function') {
      const body = new Blob([JSON.stringify({ surface, at: Date.now() })],
                            { type: 'application/json' });
      navigator.sendBeacon('/homepage/beacon-applied', body);
    }
  } catch { /* silent */ }
}
```

Add a public `POST /homepage/beacon-applied` action on `HomepageService` (public — anonymous beacons are fine; it's aggregate signal) that emits `homepage.personalized.applied` with the surface tag.

Wire `beaconApplied('verb-order')` etc. into each surface application call site in `coordinator.ts`.

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/unit/jobs/homepage-link-health-for-you.test.js` — PASS.
Run: `cd hugo-apps && npx vitest run src/homepage-personalizer/` — PASS.

- [ ] **Step 7: Commit**

```bash
git add hugo/assets/ srv/jobs/homepage-link-health.js srv/lib/observability.js srv/homepage-service.cds srv/homepage-service.js hugo-apps/src/homepage-personalizer/beacon.ts hugo-apps/src/homepage-personalizer/coordinator.ts test/unit/jobs/homepage-link-health-for-you.test.js
git commit -m "feat(#763): CLS skeletons, link-health extension, request+applied metrics"
```

---

## Task 20: Docs + smoke test + PR

**Files:**
- Create: `docs/developers/architecture/homepage-personalization.md`
- Create: `docs/authors/homepage-for-you-runbook.md`
- Create: `docs/authors/homepage-personalization-manual-tests.md`
- Modify: `docs/developers/architecture/homepage.md`
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md`
- Create: `test/smoke/homepage-personalized.test.js`

- [ ] **Step 1: Write the architecture doc**

`docs/developers/architecture/homepage-personalization.md` — condensed from the spec §4 + §6 + §11. ~2 screens. Cross-links back to the spec. Explicitly documents:
- The `X-Personalization: 1` marker + `Cache-Control: private, no-store` invariant.
- The BroadcastChannel + storage fallback.
- The kill switch.
- The persona-tag validator source of truth.

- [ ] **Step 2: Write the For-you curator runbook**

`docs/authors/homepage-for-you-runbook.md`:
- Where to go: `/admin-ui/#for-you`.
- Healthy pool size: 15-30 active candidates.
- Every candidate should carry ≥1 persona tag; unpersona'd = drops from For-you row.
- Weight guidance: use `+3..+7` for strong matches; leave `0` for generic "everyone with this role".
- Broken links: how the red-dot indicator works.

- [ ] **Step 3: Manual test plan**

`docs/authors/homepage-personalization-manual-tests.md` — copy the 8 scenarios from spec §13.1 verbatim.

- [ ] **Step 4: Cross-link from `homepage.md`**

Add a new section to `docs/developers/architecture/homepage.md` (immediately below "Explainer popovers"):

```markdown
## Personalization for signed-in users

Issue #763 adds per-user reordering + filtering + a "For you" row.
See **[homepage-personalization.md](homepage-personalization.md)** for:
- Endpoint contract + ETag/304 + `X-Personalization: 1` marker
- Persona-tag admin workflow
- BroadcastChannel live re-render + `?default=1` bypass
- Kill switch (`HomepageConfig.personalizationEnabled`)
```

- [ ] **Step 5: Add gotchas**

Append to `docs/developers/reference/tutorials-ims-gotchas.md`:
- Personalization endpoint MUST set `X-Personalization: 1` and `Cache-Control: private, no-store` — the approuter is documented to never cache this header combination.
- The client-side ETag round-trip in `sessionStorage['sap-devs-homepage-personalized']` — clearing the sessionStorage forces a fresh fetch.

- [ ] **Step 6: Write smoke test**

```js
// test/smoke/homepage-personalized.test.js
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const USER = process.env.SMOKE_USER;
const PASS = process.env.SMOKE_PASS;

const canRun = !!(BASE && USER && PASS);
const maybe = canRun ? describe : describe.skip;

maybe('deployed personalization endpoint', () => {
  it('returns X-Personalization: 1 on 200', async () => {
    const auth = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
    const r = await fetch(`${BASE}/homepage/personalized`, {
      headers: { Authorization: auth },
    });
    expect([200, 204]).toContain(r.status);
    if (r.status === 200) {
      expect(r.headers.get('cache-control')).toContain('no-store');
      expect(r.headers.get('x-personalization')).toBe('1');
    }
  });
});
```

Add script to `package.json` if not already present: `"test:smoke:personalization": "vitest run test/smoke/homepage-personalized.test.js"`.

- [ ] **Step 7: Run everything one last time**

```bash
npm test -- --run
cd hugo-apps && npx vitest run && cd ..
```
Expected: PASS across the board.

- [ ] **Step 8: Push the branch and open PR**

```bash
git branch --show-current   # verify we're on the feature branch, not main
git push -u origin HEAD
gh pr create --title "feat(#763): homepage personalization from user learning configuration" \
             --body "Implements the design at docs/superpowers/specs/2026-07-04-763-homepage-personalization-design.md. Ships DEV-first with HomepageConfig.personalizationEnabled=false; admin flips it on after DEV smoke."
```

- [ ] **Step 9: Post-merge rollout**

- Deploy to DEV via canonical local deploy or the standard MTA pipeline.
- Confirm the endpoint returns 204 by default.
- Sign in, open `/admin-ui/#homepage`, edit `HomepageConfig`, toggle `personalizationEnabled: true`.
- Set at least three `HomepageForYouCandidates` rows with `role:developer` tags (or whichever role you have prefs for) so the For-you row renders.
- Visit `/` and confirm verb reorder + badge + For-you row.
- Watch `homepage.personalized.requests{result}` and `homepage.personalized.applied{surface}` metrics for a couple of days.
- Promote to STAGE and PROD via the standard flow at cutover.

---

## Self-Review

**Spec coverage check** — walking spec sections against tasks:

| Spec § | Task(s) |
|---|---|
| §3 P1 (verb spine) | 4, 10 |
| §3 P2 (teaser rerank) | 12 |
| §3 P3 (For-you row) | 13 |
| §3 P4 (verb sub-page shelves) | 14 |
| §3 P5 (admin tags) | 1, 8, 17, 18 |
| §3 P6 (badge) | 11 |
| §3 P7 (live re-render) | 16 |
| §3 P8 (RSS filter) | 15 |
| §3 P9 (video filter) | 15 |
| §4 arch diagram | 7, 9 |
| §5 data model | 1, 6 |
| §5.3 vocab + drift guard | 2 |
| §6 endpoint contract | 7 |
| §7 algorithm | 3, 4, 5 |
| §8 client hydration | 9, 10, 11, 12, 13, 14, 15, 16 |
| §9 badge | 11 |
| §10 admin workflow | 17, 18 |
| §10.3 link health | 19 |
| §11 observability | 19 |
| §12 rollout (default off) | 6, 20 |
| §13 testing | tests in every task + smoke in 20 |
| §14 risks R4 (CDN header) | 7, 20 (smoke) |
| §14 risks R7 (payload size) | not explicitly asserted — TODO below |
| §15 deferred | (none — out of scope) |
| §16 docs | 20 |

**Two gaps caught in review:**

1. **R7 payload-size assertion.** Add to the endpoint integration test in Task 7:
   ```js
   it('envelope stays under 10KB', async () => {
     const r = await srv.get('/homepage/personalized').auth('alice', 'password');
     const size = Buffer.byteLength(JSON.stringify(r.body), 'utf8');
     expect(size).toBeLessThan(10 * 1024);
   });
   ```
   *(Add this step to Task 7 during implementation — noted here for the executor.)*

2. **Live-round-trip smoke test.** Spec §13 asks for a hybrid smoke that sets prefs → `/` reflects. That belongs in Task 20's smoke file as a second scenario, gated on `SMOKE_HYBRID=1`:
   ```js
   maybe.skipIf(!process.env.SMOKE_HYBRID)('reflects prefs on /', async () => {
     // 1) POST /api/setLearningPreferences { role: 'developer' }
     // 2) fetch /homepage/personalized, expect verbOrder[0] === 'build'
   });
   ```
   *(Add during Task 20 execution.)*

**Placeholder scan:** grep for TBD/TODO/XXX/FIXME across the plan — one intentional TODO callout in the self-review above, none in tasks. Clean.

**Type consistency:** `Envelope`, `applyVerbOrder`, `applyTeaserRerank`, `applyShelfRerank`, `mountForYou`, `renderBadge`, `applyVideoFilter`, `applyRssFilter`, `subscribeBroadcast`, `broadcastPreferencesChanged`, `readSessionCache`, `writeSessionCache`, `boot`, `buildEnvelope`, `hashEnvelope`, `validateTags`, `matches`, `isHidden`, `scoreEntry`, `rankShelves`, `rankForYou`, `computeVerbOrder`, `BASE_ORDER` — all consistent across the tasks that reference them.

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-04-763-homepage-personalization.md`.**
