# Frontmatter-Authoritative Tutorial Owner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the tutorial's source markdown frontmatter (`author_profile`) the durable source of truth for `Tutorials.author_ID`, overwriting any drift caused by the existing commit-history fallback, and fix the admin Advocate edit screen to use the same 4-source view that the public `/api/advocates` already uses.

**Architecture:** Add a `Users.githubLogin` column. Extend the frontmatter parser to extract the GitHub login from `author_profile` URLs and propagate it through `fetch-tutorials.ts` → Hugo frontmatter → `publish-content.ts` payload. Insert a new **Phase 0** at the top of `resolveTutorialAuthor` that matches the frontmatter login against `Users.githubLogin` and beats every existing email-based phase. Switch the publish-time `UPDATE Tutorials.author_ID` from "only-fill-NULLs" to "frontmatter-wins overwrite" — but only when Phase 0 produced a hit (so commit-history fallback never silently overwrites). Add an `AdminService.MyTutorials` projection bound to `MyTutorialsView` and re-bind the Advocate object page's tutorial facet to it.

**Tech Stack:** CAP Node.js + CDS, HANA Cloud, Vitest (unit + hybrid), Fiori Elements V4, Hugo build pipeline. No new external dependencies.

**Worktree:** Implement on a worktree at `.claude/worktrees/owner-frontmatter` branched off `main` (per the `feedback_worktrees_never_on_main` and `feedback_worktree_directory_convention` memories).

**Spec backreference:** Builds directly on [docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md](../specs/2026-06-24-tutorial-authorship-fk-design.md) and the #777 plan at [docs/superpowers/plans/2026-06-29-777-author-owner-reconciliation.md](2026-06-29-777-author-owner-reconciliation.md). Those two changes fixed the read side; this plan fixes the write side and the missed admin surface.

---

## File Structure

### New files

| Path | Responsibility |
| --- | --- |
| `scripts/parsers/__tests__/github-login-from-profile.test.ts` | Unit tests for the parser helper that extracts a GitHub login from `author_profile`. |
| `scripts/parsers/github-login-from-profile.ts` | Pure helper. Takes an `author_profile` URL and returns `{ githubLogin: string \| null }`. |
| `srv/lib/__tests__/resolve-tutorial-author-frontmatter.test.js` | New tests for Phase 0 of the resolver. |
| `scripts/backfill-users-github-login.cjs` | One-shot script that populates `Users.githubLogin` from `TutorialContributors.login` and from any contributors-array data the most recent manifest carries. Idempotent (`WHERE githubLogin IS NULL`). |
| `test/hybrid/frontmatter-owner.test.js` | Hybrid test asserting that publishing a tutorial whose `author_profile` resolves to user A overwrites a previously-set `Tutorials.author_ID` of user B. |
| `test/hybrid/admin-advocate-mytutorials.test.js` | Hybrid test asserting that `AdminService.MyTutorials` reads through `MyTutorialsView` (i.e., picks up Source 3/Source 4 hits, not just Source 1/2). |

### Modified files

| Path | Change |
| --- | --- |
| `db/schema.cds` (Users entity) | Add `githubLogin : String(100);` column with `@assert.unique`. |
| `db/views.cds` | Add a new `MyTutorialsByUuid` projection (or extend `MyTutorialsView`) keyed for the Admin/Advocate UI's needs — see Task 7. |
| `db/advocates.cds` | Replace the two direct associations with a navigation through the new view. |
| `srv/admin-service.cds` | Add `entity MyTutorials as projection on MyTutorialsView` exposed under `/admin/`. |
| `srv/admin-service.js` | Add `before('READ', MyTutorials)` to require admin scope (no `req.user.id` filter — admins see all users' rows). |
| `app/admin-annotations.cds` | Re-target the Advocate object page tutorial facets to the new projection. |
| `scripts/parsers/types.ts` | Add `githubLogin?: string \| null` to the `SourceFrontmatter` and Hugo frontmatter types. |
| `scripts/fetch-tutorials.ts` | Call the new helper, emit `githubLogin` into the Hugo frontmatter. |
| `scripts/parsers/render-frontmatter.ts` | Render `githubLogin` if present. |
| `scripts/publish-content.ts` | Include `githubLogin` in the per-slug publish payload alongside `primaryContributorEmail`. |
| `srv/lib/content-publish-session.js` | Pass `frontmatterGithubLogin` + `loginToUserId` map into the resolver; switch the `UPDATE Tutorials.author_ID` from `WHERE AUTHOR_ID IS NULL` to unconditional when a Phase 0 hit fires. |
| `srv/lib/resolve-tutorial-author.js` | Insert Phase 0: frontmatter `githubLogin` → `loginToUserId.get(login)` beats every existing phase. Return a `source: 'frontmatter' \| 'role-match' \| 'any-contributor' \| 'owner-email' \| null` discriminant so callers know whether to overwrite. |
| `srv/lib/__tests__/resolve-tutorial-author.test.js` | Add cases for Phase 0 + the `source` discriminant. |

---

## Task 1: Worktree + branch + skeleton commit

**Files:** none yet (just setup)

- [ ] **Step 1: Create worktree**

```bash
cd d:/projects/tutorials-poc
git fetch origin
git worktree add -b feat/frontmatter-owner .claude/worktrees/owner-frontmatter origin/main
cd .claude/worktrees/owner-frontmatter
```

Expected: new branch `feat/frontmatter-owner` checked out at `.claude/worktrees/owner-frontmatter`.

- [ ] **Step 2: Sanity-check tools**

```bash
node --version   # expect v20+
npm test -- --reporter=verbose --run scripts/__tests__/frontmatter.test.ts
```

Expected: existing frontmatter tests pass — confirms toolchain is healthy in the worktree.

- [ ] **Step 3: Commit a stub plan reference**

```bash
git add docs/superpowers/plans/2026-06-30-frontmatter-authoritative-tutorial-owner.md
git commit -m "docs: add frontmatter-authoritative-owner plan"
```

---

## Task 2: GitHub-login-from-profile parser helper (TDD)

**Files:**
- Create: `scripts/parsers/github-login-from-profile.ts`
- Test: `scripts/parsers/__tests__/github-login-from-profile.test.ts`

`author_profile` values in the wild (from grepping cached frontmatter):
- `https://github.com/jung-thomas` → `jung-thomas`
- `https://www.github.com/SAP-samples` → `SAP-samples`
- `https://people.sap.com/thomas.jung` → null (not a GitHub URL; Phase 0 misses, falls through)
- `https://github.com/foo/` (trailing slash) → `foo`
- `https://github.com/foo/bar/baz` → `foo` (first path segment only)
- `` / undefined / non-URL string → null
- `github.com/foo` (no scheme) → `foo` (tolerate)

- [ ] **Step 1: Write the failing tests**

```ts
// scripts/parsers/__tests__/github-login-from-profile.test.ts
import { describe, it, expect } from 'vitest';
import { extractGithubLoginFromProfile } from '../github-login-from-profile.js';

describe('extractGithubLoginFromProfile', () => {
  it('returns the login for a plain github.com URL', () => {
    expect(extractGithubLoginFromProfile('https://github.com/jung-thomas')).toBe('jung-thomas');
  });
  it('tolerates the www. subdomain', () => {
    expect(extractGithubLoginFromProfile('https://www.github.com/SAP-samples')).toBe('SAP-samples');
  });
  it('strips a trailing slash', () => {
    expect(extractGithubLoginFromProfile('https://github.com/foo/')).toBe('foo');
  });
  it('returns the first path segment when deeper paths are present', () => {
    expect(extractGithubLoginFromProfile('https://github.com/foo/bar/baz')).toBe('foo');
  });
  it('returns null for non-github URLs', () => {
    expect(extractGithubLoginFromProfile('https://people.sap.com/thomas.jung')).toBeNull();
  });
  it('returns null for empty / null / undefined input', () => {
    expect(extractGithubLoginFromProfile('')).toBeNull();
    expect(extractGithubLoginFromProfile(null)).toBeNull();
    expect(extractGithubLoginFromProfile(undefined)).toBeNull();
  });
  it('tolerates missing scheme', () => {
    expect(extractGithubLoginFromProfile('github.com/foo')).toBe('foo');
  });
  it('preserves case (GitHub logins are case-insensitive but Users.githubLogin stores canonical case)', () => {
    expect(extractGithubLoginFromProfile('https://github.com/Riley-Rainey')).toBe('Riley-Rainey');
  });
  it('rejects reserved GitHub paths', () => {
    // /settings, /marketplace, etc. are not user logins
    expect(extractGithubLoginFromProfile('https://github.com/settings/profile')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npm test -- --run scripts/parsers/__tests__/github-login-from-profile.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement minimal helper**

```ts
// scripts/parsers/github-login-from-profile.ts
/**
 * Reserved GitHub path segments that cannot be a user login.
 * Source: https://github.com/shinnn/github-username-regex + GitHub's own reserved list.
 */
const RESERVED = new Set([
  'settings', 'marketplace', 'pricing', 'about', 'features', 'security',
  'enterprise', 'team', 'collections', 'topics', 'trending', 'login',
  'logout', 'join', 'sponsors', 'orgs', 'organizations', 'codespaces',
  'notifications', 'pulls', 'issues', 'explore', 'new', 'search',
]);

export function extractGithubLoginFromProfile(profile: unknown): string | null {
  if (typeof profile !== 'string') return null;
  const s = profile.trim();
  if (s.length === 0) return null;

  // Tolerate missing scheme.
  const normalized = /^https?:\/\//i.test(s) ? s : `https://${s}`;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'github.com') return null;

  const seg = url.pathname.split('/').filter(Boolean)[0];
  if (!seg) return null;
  if (RESERVED.has(seg.toLowerCase())) return null;

  // GitHub login: 1-39 chars, alnum or hyphen, no leading/trailing hyphen.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(seg)) return null;
  return seg;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
npm test -- --run scripts/parsers/__tests__/github-login-from-profile.test.ts
```

Expected: all 9 cases pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/github-login-from-profile.ts scripts/parsers/__tests__/github-login-from-profile.test.ts
git commit -m "feat(owner): parser helper to extract GitHub login from author_profile URL"
```

---

## Task 3: Plumb `githubLogin` through fetch + publish payload

**Files:**
- Modify: `scripts/parsers/types.ts`
- Modify: `scripts/fetch-tutorials.ts:896-916` (writeHugoPage call site)
- Modify: `scripts/parsers/render-frontmatter.ts` (emit `githubLogin` if present)
- Modify: `scripts/publish-content.ts:413-429` (carry `githubLogin` into publish payload)
- Test: extend `scripts/__tests__/frontmatter.test.ts`

- [ ] **Step 1: Extend `SourceFrontmatter` type**

```ts
// scripts/parsers/types.ts — add to existing interface
export interface SourceFrontmatter {
  // ...existing fields...
  author_name: string;
  author_profile: string;
  // New: not present in source markdown; computed during fetch.
  githubLogin?: string | null;
}
```

- [ ] **Step 2: Write the failing test** (extend `scripts/__tests__/frontmatter.test.ts`)

```ts
it('renders githubLogin into Hugo frontmatter when author_profile is a github.com URL', () => {
  // Use the existing fixture + render path; assert that the emitted YAML contains
  // `githubLogin: jung-thomas` when author_profile is `https://github.com/jung-thomas`.
});
```

- [ ] **Step 3: Run, verify FAIL** (no plumbing yet)

```bash
npm test -- --run scripts/__tests__/frontmatter.test.ts
```

Expected: FAIL — no `githubLogin` in rendered output.

- [ ] **Step 4: Implement plumbing in fetch-tutorials.ts and render-frontmatter.ts**

In `scripts/fetch-tutorials.ts` (around line 896, the `writeHugoPage` call site):

```ts
import { extractGithubLoginFromProfile } from './parsers/github-login-from-profile.js';
// ...
const githubLogin = extractGithubLoginFromProfile(frontmatter.author_profile ?? '');
writeHugoPage(
  t.slug,
  title,
  description,
  frontmatter.time ?? 15,
  level,
  frontmatter.tags ?? [],
  frontmatter.primary_tag ?? '',
  frontmatter.author_name ?? 'Unknown',
  frontmatter.author_profile ?? '',
  githubLogin,  // NEW positional arg, OR pass as an options bag — see existing call shape
  // ...rest unchanged
);
```

Update `writeHugoPage`'s signature and forward `githubLogin` into the YAML it renders via `render-frontmatter.ts`. Render conditionally — only emit the key if the value is non-null, to keep frontmatter diffs minimal for non-GitHub `author_profile` values.

- [ ] **Step 5: Run frontmatter test, verify PASS**

- [ ] **Step 6: Extend publish-content.ts payload**

In `scripts/publish-content.ts` around line 413:

```ts
const contributors = Array.isArray(fm.contributors) ? fm.contributors : [];
const primary = contributors.length > 0 ? contributors[0] : null;
const primaryContributorEmail = primary ? trim((primary as any).email) : null;
const primaryContributorLogin = primary ? trim((primary as any).login) : null;
const frontmatterGithubLogin = typeof fm.githubLogin === 'string' && fm.githubLogin.trim().length > 0
  ? fm.githubLogin.trim()
  : null;

result[slug] = {
  // ...
  primaryContributorEmail,
  primaryContributorLogin,
  frontmatterGithubLogin,  // NEW — Phase 0 source-of-truth signal
};
```

- [ ] **Step 7: Commit**

```bash
git add scripts/parsers/types.ts scripts/fetch-tutorials.ts \
        scripts/parsers/render-frontmatter.ts scripts/publish-content.ts \
        scripts/__tests__/frontmatter.test.ts
git commit -m "feat(owner): emit githubLogin into Hugo frontmatter and publish payload"
```

---

## Task 4: Add `Users.githubLogin` column (CDS + cds build)

**Files:**
- Modify: `db/schema.cds` (Users entity)
- Stage: `db/last-dev/csn.json` + `db/src/` (per the `feedback_cds_schema_plans_need_cds_build_production_step` memory)

- [ ] **Step 1: Add the column**

```cds
// db/schema.cds — Users entity
entity Users : cuid, managed {
  // ...existing fields...
  githubLogin : String(100);
  // @assert.unique not strictly needed in CDS — we enforce via partial index below.
  // Reason: GitHub allows login changes, so historical Users may legitimately share a stale value.
}

// Partial uniqueness: only enforce for non-null values.
// (CAP CDS handles this via @assert.unique.<name> on the entity)
annotate Users with @assert.unique : {
  githubLoginPartial : [ githubLogin ]
};
```

- [ ] **Step 2: Build CDS**

```bash
cds build --production
git add db/schema.cds db/last-dev/ db/src/
```

Per the `feedback_cds_build_production_not_cds_compile_for_last_dev` memory: `cds build`, NOT `cds compile`.

- [ ] **Step 3: Run hybrid schema deploy test**

```bash
cf login -a https://api.cf.eu10-005.hana.ondemand.com -o tutorial-system -s dev
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- --run test/hybrid/schema.test.js
```

Expected: PASS. Confirms the new column deploys cleanly to HANA.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(owner): add Users.githubLogin column with partial uniqueness"
```

---

## Task 5: One-shot backfill script for `Users.githubLogin`

**Files:**
- Create: `scripts/backfill-users-github-login.cjs`
- Test: extend `test/hybrid/frontmatter-owner.test.js` (created in Task 8)

Strategy: derive `Users.githubLogin` from two sources, in priority order:
1. `TutorialContributors.login` (already known-good, populated from GitHub API)
2. Any historical `primaryContributorLogin` carried on `ContentManifest` rows (sourced from publish payloads)

Match `Users` by `email`. Idempotent: `WHERE githubLogin IS NULL`.

- [ ] **Step 1: Write the script**

```js
// scripts/backfill-users-github-login.cjs
// Idempotent. Run with: npx cds bind --exec -- node scripts/backfill-users-github-login.cjs --commit
const cds = require('@sap/cds');

(async () => {
  const dryRun = !process.argv.includes('--commit');
  await cds.connect.to('db');
  const db = cds.db;

  // Phase A: derive from TutorialContributors.
  const rows = await db.run(`
    SELECT DISTINCT u."ID" as user_id, c."login"
    FROM "Users" u
    INNER JOIN "TutorialContributors" c ON LOWER(TRIM(c."email")) = LOWER(TRIM(u."email"))
    WHERE u."githubLogin" IS NULL
      AND c."login" IS NOT NULL
      AND LENGTH(TRIM(c."login")) > 0
  `);

  console.log(`Found ${rows.length} Users rows to populate from TutorialContributors`);
  let updated = 0;
  for (const r of rows) {
    if (dryRun) continue;
    const res = await db.run(
      `UPDATE "Users" SET "githubLogin" = ? WHERE "ID" = ? AND "githubLogin" IS NULL`,
      [r.LOGIN, r.USER_ID]
    );
    updated += res || 0;
  }
  console.log(`${dryRun ? '[DRY RUN] would update' : 'Updated'} ${updated} rows`);
})();
```

- [ ] **Step 2: Dry-run on DEV**

```bash
npx cds bind --exec -- node scripts/backfill-users-github-login.cjs
```

Expected: prints a non-zero count; no UPDATEs executed.

- [ ] **Step 3: Commit; defer the `--commit` run until after Task 6 ships**

```bash
git add scripts/backfill-users-github-login.cjs
git commit -m "feat(owner): one-shot backfill of Users.githubLogin from TutorialContributors"
```

---

## Task 6: Resolver Phase 0 — frontmatter wins (TDD)

**Files:**
- Modify: `srv/lib/resolve-tutorial-author.js`
- Modify: `srv/lib/__tests__/resolve-tutorial-author.test.js`

The new signature:

```js
resolveTutorialAuthor({
  contributors,          // existing
  ownerEmail,            // existing
  emailToUserId,         // existing
  frontmatterGithubLogin,// NEW — from publish payload
  loginToUserId,         // NEW — Map<LOWER(login), Users.ID>
}) => {
  authorUserId,
  source: 'frontmatter' | 'role-match' | 'any-contributor' | 'owner-email' | null,
  contributorUserIds,
  orphans
}
```

- [ ] **Step 1: Write failing tests**

```js
// srv/lib/__tests__/resolve-tutorial-author-frontmatter.test.js
import { describe, it, expect } from 'vitest';
import { resolveTutorialAuthor } from '../resolve-tutorial-author.js';

describe('resolveTutorialAuthor — Phase 0 (frontmatter)', () => {
  it('returns the frontmatter login match as authorUserId with source=frontmatter', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: null }],
      ownerEmail: 'riley@sap.com',
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: 'jung-thomas',
      loginToUserId: new Map([['jung-thomas', 'USER-TOM']]),
    });
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('frontmatter');
  });

  it('falls through to Phase A/B/C when frontmatter login is unknown', () => {
    const result = resolveTutorialAuthor({
      contributors: [{ email: 'riley@sap.com', role: 'author' }],
      ownerEmail: null,
      emailToUserId: new Map([['riley@sap.com', 'USER-RILEY']]),
      frontmatterGithubLogin: 'ghost-login',
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBe('USER-RILEY');
    expect(result.source).toBe('role-match');
  });

  it('returns null source when nothing matches', () => {
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: null,
      emailToUserId: new Map(),
      frontmatterGithubLogin: null,
      loginToUserId: new Map(),
    });
    expect(result.authorUserId).toBeNull();
    expect(result.source).toBeNull();
  });

  it('treats login comparison as case-insensitive', () => {
    const result = resolveTutorialAuthor({
      contributors: [],
      ownerEmail: null,
      emailToUserId: new Map(),
      frontmatterGithubLogin: 'Jung-Thomas',
      loginToUserId: new Map([['jung-thomas', 'USER-TOM']]),
    });
    expect(result.authorUserId).toBe('USER-TOM');
    expect(result.source).toBe('frontmatter');
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement Phase 0**

In `srv/lib/resolve-tutorial-author.js`, prepend Phase 0 before existing Phase B:

```js
// Phase 0 — frontmatter author_profile → Users.githubLogin. BEATS every other phase.
function normalizeLogin(login) {
  if (login === null || login === undefined) return null;
  const s = String(login).trim().toLowerCase();
  return s.length === 0 ? null : s;
}

export function resolveTutorialAuthor({
  contributors,
  ownerEmail,
  emailToUserId,
  frontmatterGithubLogin = null,
  loginToUserId = new Map(),
} = {}) {
  // ...existing Phase A (per-contributor email lookup) stays identical...

  let authorUserId = null;
  let source = null;

  // Phase 0 — frontmatter login takes precedence.
  const fmLogin = normalizeLogin(frontmatterGithubLogin);
  if (fmLogin) {
    const fmMap = loginToUserId instanceof Map ? loginToUserId : new Map();
    const userId = fmMap.get(fmLogin);
    if (userId) {
      authorUserId = userId;
      source = 'frontmatter';
    }
  }

  // Phase B (a) role-match — only if Phase 0 missed
  if (!authorUserId) { /* ...existing logic... assign source='role-match' on hit */ }

  // Phase B (b) any contributor — only if (a) missed
  if (!authorUserId) { /* ...existing... assign source='any-contributor' on hit */ }

  // Phase B (c) ownerEmail — only if (b) missed
  if (!authorUserId) { /* ...existing... assign source='owner-email' on hit */ }

  // ...orphan logic unchanged...

  return { authorUserId, source, contributorUserIds, orphans };
}
```

- [ ] **Step 4: Run NEW + EXISTING tests, verify all PASS**

```bash
npm test -- --run srv/lib/__tests__/resolve-tutorial-author
```

The existing tests must still pass; if any break, the discriminant addition was non-backward-compatible — fix.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/resolve-tutorial-author.js srv/lib/__tests__/
git commit -m "feat(owner): resolver Phase 0 — frontmatter githubLogin beats commit-history fallback"
```

---

## Task 7: Publish path — frontmatter wins, overwrite policy

**Files:**
- Modify: `srv/lib/content-publish-session.js` (around line 587 and 718-724)
- Test: `test/hybrid/frontmatter-owner.test.js` (NEW)

- [ ] **Step 1: Write the failing hybrid test**

```js
// test/hybrid/frontmatter-owner.test.js
// Verifies: publishing a tutorial whose frontmatter author_profile resolves
// to user A overwrites a previously-set Tutorials.author_ID of user B.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('frontmatter author wins on publish (hybrid)', () => {
  // ...setup: create __TEST__ Users with both githubLogin set,
  // create a Tutorial with author_ID = USER_B,
  // publish a manifest with frontmatterGithubLogin pointing to USER_A,
  // assert author_ID is now USER_A.
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- --run test/hybrid/frontmatter-owner.test.js
```

- [ ] **Step 3: Implement publish-path changes**

In `srv/lib/content-publish-session.js`:

1. Around line 587, where the per-slug meta is unpacked, also pull `frontmatterGithubLogin`.
2. Before the call to `resolveTutorialAuthor`, build a `loginToUserId` map ONCE per publish session by `SELECT ID, githubLogin FROM Users WHERE githubLogin IS NOT NULL` and keying by LOWER(githubLogin).
3. Pass `frontmatterGithubLogin` + `loginToUserId` into the resolver call.
4. After the resolver returns, branch on `source`:

```js
const { authorUserId, source, contributorUserIds } = resolveTutorialAuthor({
  contributors: contribs,
  ownerEmail,
  emailToUserId,
  frontmatterGithubLogin: meta.frontmatterGithubLogin || null,
  loginToUserId,
});

if (authorUserId) {
  if (source === 'frontmatter') {
    // Frontmatter is authoritative — overwrite.
    await db.run(
      `UPDATE ${tutorialsTable} SET "AUTHOR_ID" = ? WHERE "ID" = ?`,
      [authorUserId, tutorialId]
    );
  } else {
    // Commit-history fallback — preserve existing admin/manual corrections.
    await db.run(
      `UPDATE ${tutorialsTable} SET "AUTHOR_ID" = ? WHERE "ID" = ? AND "AUTHOR_ID" IS NULL`,
      [authorUserId, tutorialId]
    );
  }
}
```

- [ ] **Step 4: Run hybrid test, verify PASS**

- [ ] **Step 5: Run full unit + hybrid suites** to check nothing regressed

```bash
npm test
ALLOW_HYBRID_WRITES=true npm run test:hybrid
```

- [ ] **Step 6: Commit**

```bash
git add srv/lib/content-publish-session.js test/hybrid/frontmatter-owner.test.js
git commit -m "feat(owner): frontmatter author_profile authoritatively overwrites Tutorials.author_ID"
```

---

## Task 8: AdminService.MyTutorials projection + admin advocate UI rebind

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Modify: `db/advocates.cds` (Advocates entity navigation)
- Modify: `app/admin-annotations.cds` (Advocates object page facets)
- Test: `test/hybrid/admin-advocate-mytutorials.test.js` (NEW)

The challenge: the admin Advocate object page binds to `authoredTutorials` / `contributedTutorials` via direct CDS associations on `Advocates`. The cleanest swap is to add a navigation property on `Advocates` that goes through `MyTutorialsView`.

- [ ] **Step 1: Sketch the join via a managed-style navigation on `Advocates`**

`MyTutorialsView` keys on `(tutorial_ID, userId)` where `userId` is `Users.uuid`. `Advocates.user` is an association to Users by ID. Add a navigation:

```cds
// db/advocates.cds
entity Advocates : cuid, managed {
  // ...existing fields...
  user : Association to Users;

  // EXISTING (kept for backward compatibility with any non-Object-Page binding):
  authoredTutorials    : Association to many ims.Tutorials            on authoredTutorials.author = user;
  contributedTutorials : Association to many ims.TutorialContributors on contributedTutorials.user = user;

  // NEW — canonical 4-source view, joined by Users.uuid.
  ownedTutorials : Association to many ims.MyTutorialsView
                    on ownedTutorials.userId = user.uuid;
}
```

- [ ] **Step 2: Add admin projection** in `srv/admin-service.cds`:

```cds
service AdminService @(path:'/admin', requires: 'authenticated-user') {
  // ...
  @readonly
  entity MyTutorials as projection on db.MyTutorialsView;
}
```

- [ ] **Step 3: Guard the projection** in `srv/admin-service.js`:

```js
const { MyTutorials } = this.entities;
this.before('READ', MyTutorials, (req) => {
  // Admin-only; no per-user filter — admins legitimately need to see all rows.
  if (!req.user.is('Admin')) return req.reject(403);
});
```

- [ ] **Step 4: Re-target advocate facets** in `app/admin-annotations.cds`:

Replace the two existing facets:

```cds
// BEFORE:
// { $Type: 'UI.ReferenceFacet', ID: 'AuthoredTutorials',    Target: 'authoredTutorials/@UI.LineItem' },
// { $Type: 'UI.ReferenceFacet', ID: 'ContributedTutorials', Target: 'contributedTutorials/@UI.LineItem' }

// AFTER:
{ $Type: 'UI.ReferenceFacet', ID: 'OwnedTutorials', Label: 'Owned Tutorials',
  Target: 'ownedTutorials/@UI.LineItem' }
```

And add a minimal `@UI.LineItem` annotation on the navigation target showing slug, title, bestPriority, and a tag indicating which source matched (Source 1 = strong, Source 4 = legacy fuzzy).

- [ ] **Step 5: Write the failing hybrid test**

```js
// test/hybrid/admin-advocate-mytutorials.test.js
// Setup: create __TEST__ Advocate for a user who is owner via Source 3 only
// (TutorialMeta.ownerEmail match, but NOT via Tutorials.author_ID).
// Assert: AdminService.MyTutorials returns that tutorial when filtered by
// userId = advocate.user.uuid.
```

- [ ] **Step 6: Build CDS, deploy schema, run hybrid test**

```bash
cds build --production
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- --run test/hybrid/admin-advocate-mytutorials.test.js
```

Expected: PASS.

- [ ] **Step 7: Build admin-shell + commit**

```bash
npm run build:apps
git add db/advocates.cds srv/admin-service.cds srv/admin-service.js \
        app/admin-annotations.cds test/hybrid/admin-advocate-mytutorials.test.js \
        db/last-dev/ db/src/
git commit -m "feat(owner): admin Advocate object page reads tutorials via MyTutorialsView"
```

---

## Task 9: Deploy DEV, run backfill, content republish, verify

**Files:** none — operational steps only.

- [ ] **Step 1: Confirm deploy scope with Tom**

Ask: "About to deploy: backend (srv + db schema change) + admin-shell rebuild. **Not** a content republish — that needs a separate `gh workflow run rebuild-content.yml`. Proceed?"

Per the `feedback_confirm_deploy_scope` memory.

- [ ] **Step 2: From the primary tree on `main`, deploy**

```bash
cd d:/projects/tutorials-poc
git checkout main && git pull
git merge --no-ff feat/frontmatter-owner   # or merge the PR after Step 12 below
npm run build:all
envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

Per the `feedback_always_deploy_from_main_primary_tree` and `project_local_deploy_process` memories.

- [ ] **Step 3: Run the Users.githubLogin backfill**

```bash
cd d:/projects/tutorials-poc
npx cds bind --exec -- node scripts/backfill-users-github-login.cjs --commit
```

- [ ] **Step 4: Trigger a full content republish** so the new Phase 0 resolver runs against every slug

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full
```

This is necessary because the resolver change only fires at publish time. Expected wall-clock ~10 min.

- [ ] **Step 5: Verify Symptom 1 (Riley shown as owner)**

```bash
# Query the admin AdminService for a tutorial known to be authored by Tom in frontmatter
# but previously linked to Riley in DB. Confirm author_ID is now Tom's.
```

- [ ] **Step 6: Verify Symptom 2 ("Monitored by me" returns rows)**

Open `/admin-ui/#tutorial-dashboard`, log in as Tom, click "Monitored by me", expect non-zero rows.

- [ ] **Step 7: Verify Symptom 3 (Advocate edit screen shows ~77)**

Open `/admin-ui/#advocates-display` → Tom's record → check "Owned Tutorials" facet. Expect ~77 rows, matching `/api/advocates`.

- [ ] **Step 8: Commit any final fixes that fell out of verification**

---

## Task 10: PR + plan review loop

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/frontmatter-owner
gh pr create --base main --title "feat(owner): frontmatter author_profile is authoritative" \
  --body "$(cat <<'EOF'
Fixes three related symptoms reported by Tom on 2026-06-30:

1. Riley shown as owner of tutorials he only contributed to (because his commit was most recent — contributors[0]).
2. "Monitored by me" on Tutorial Health returns zero even when rows show user as owner.
3. Advocate edit screen shows only 7 tutorials when ~77 are owned (admin facets bypass MyTutorialsView).

Root cause: the system derived ownership from GitHub commit history (`contributors[0]`),
not from the tutorial's source frontmatter. PR #777 papered over this on the read side
(4-source UNION view) but the write side and the admin Advocate UI were not fixed.

This PR:
- Adds `Users.githubLogin` + one-shot backfill from TutorialContributors
- Extracts the GitHub login from frontmatter `author_profile`, plumbs it through the publish payload
- Inserts a new Phase 0 in `resolveTutorialAuthor` that beats every existing phase
- Switches the publish-path UPDATE from fill-NULLs to frontmatter-wins-overwrites
- Adds `AdminService.MyTutorials` projection on `MyTutorialsView`
- Re-binds the Advocate object page tutorial facet to it

Tests: unit (parser + resolver), hybrid (publish overwrite + admin facet binding).
Closes #<issue>.
EOF
)"
```

- [ ] **Step 2: Dispatch the plan-document-reviewer** on this plan file (per the writing-plans skill's review loop).

---

## Risks & open questions

1. **GitHub login collisions across users** — partial uniqueness lets multiple historical Users rows share a NULL `githubLogin`, but a deliberate collision (two Users rows both backfilled to `foo`) would fail the unique check. The backfill picks the first-seen contributor row per Users.email match, so this is deterministic; flag any backfill error to Tom for manual resolution.
2. **`author_profile` is not always a GitHub URL** — for those tutorials Phase 0 misses and the existing fallback chain runs unchanged. Behavior identical to today for those, which is acceptable.
3. **Admin manual corrections** — the spec says "frontmatter wins, overwrite." That means an admin's manual change to `Tutorials.author_ID` will be overwritten on the next publish if frontmatter resolves. If we later want admin corrections to stick, the cleanest design is to add a `Tutorials.authorLockedByAdmin: Boolean` column and gate the overwrite. Out of scope for this plan but documented here.
4. **Existing 7-tutorial advocate count for Tom** — switching the admin UI to `MyTutorialsView` shows Sources 3 and 4. If Tom wants only Phase 0 / Source 1 (strict frontmatter) rows in the admin edit screen, this plan over-delivers. The screen can be narrowed later by filtering on `bestPriority <= 2`.
