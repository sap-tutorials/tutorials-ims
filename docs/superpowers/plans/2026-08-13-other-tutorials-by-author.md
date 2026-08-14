# Other Tutorials by This Author — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let readers discover more tutorials by a tutorial's primary author, via an inline "More from this author" rail on each tutorial page plus a dedicated `/authors/{login}/` page — all baked at Hugo build time.

**Architecture:** A single build artifact `hugo/data/author_index.json` (login → author + their tutorials, with an optional `advocateSlug`) is emitted by `scripts/fetch-tutorials.ts` from the tutorial frontmatter it already parses. A new Hugo layout renders `/authors/{login}/` static pages (served by the approuter catch-all); a new partial bakes the rail into each tutorial page (which then flows through the publish→HANA pipeline). Authors who are Developer Advocates get no standalone page — a Hugo `aliases` redirect (added in `fetch-advocates.ts`) points `/authors/{login}/` at their existing `/developer-advocates/{slug}/` profile.

**Tech Stack:** TypeScript build scripts (tsx), Hugo templates (Go template), CAP Node.js (advocate feed), vitest (unit), Playwright (post-deploy e2e).

**Spec:** `docs/superpowers/specs/2026-08-13-other-tutorials-by-author-design.md`

## Global Constraints

- **Serving:** author pages are static — `/authors/*` MUST stay OFF `IN_SCOPE_PAGES` (`srv/lib/page-key-map.js`) and off the CAP `/content/pages/*` route list, so they fall through to the approuter catch-all (`approuter/xs-app.json:592`). Tutorial pages are NOT static; the baked rail reaches prod via `scripts/publish-content.ts`.
- **Author scope:** primary author only — the `author_profile`-derived GitHub login. Contributors are out of scope.
- **Identity/grouping key:** lowercase GitHub login from `extractGithubLoginFromProfile` (`scripts/parsers/github-login-from-profile.ts`). Tutorials with no resolvable login get no rail and no page.
- **QA parity:** emit `author_index.json` into the channel data dir (prod `hugo/data/`, QA `hugo/data-qa/` — `hugo.qa.toml` sets `dataDir="data-qa"`) and author content into `getHugoContentDir(channel)/authors`. Missing this repeats the `qa-datadir-override-hides-island-manifest` class of bug.
- **Fail-open:** the advocate-feed fetch used to build the login→advocateSlug map must never break the build — on any error, use an empty map (no redirects, plain author pages) and warn.
- **Generated files are gitignored:** `hugo/content/authors/*.md` (mirror the advocate pattern), keep a committed `_index.md`.
- **Reuse, don't reinvent:** the rail and author-page grid reuse `hugo/layouts/partials/next-steps-card.html` (self-resolves title/time via `site.GetPage`).
- **Windows/CRLF:** author `.md` and JSON writers use `writeFileSync(..., 'utf-8')`; keep `\n` line endings (match existing writers).

---

### Task 1: Pure author-index builder + login normalization

**Files:**
- Create: `scripts/parsers/author-index.ts`
- Test: `test/unit/author-index/build-author-index.test.ts`

**Interfaces:**
- Consumes: `extractGithubLoginFromProfile` from `scripts/parsers/github-login-from-profile.ts`.
- Produces:
  - `normalizeAuthorLogin(profile: unknown): string | null`
  - `interface AuthorTutorialRow { authorProfile: string; displayName: string; slug: string; title: string; time: number; level: string; tags: string[]; createdAt?: string; isNew: boolean }`
  - `interface AuthorIndexTutorial { slug: string; title: string; time: number; level: string; tags: string[]; isNew: boolean }`
  - `interface AuthorIndexEntry { login: string; displayName: string; githubUrl: string; advocateSlug?: string; tutorials: AuthorIndexTutorial[] }`
  - `type AuthorIndex = Record<string, AuthorIndexEntry>`
  - `buildAuthorIndex(rows: AuthorTutorialRow[], advocates: Map<string,string>): AuthorIndex`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/author-index/build-author-index.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeAuthorLogin, buildAuthorIndex } from '../../../scripts/parsers/author-index'

describe('normalizeAuthorLogin', () => {
  it('lowercases a github login', () => {
    expect(normalizeAuthorLogin('https://github.com/Thomas-Jung')).toBe('thomas-jung')
  })
  it('returns null for non-github or empty', () => {
    expect(normalizeAuthorLogin('https://example.com/foo')).toBeNull()
    expect(normalizeAuthorLogin('')).toBeNull()
  })
})

describe('buildAuthorIndex', () => {
  const row = (o: Partial<Parameters<typeof buildAuthorIndex>[0][number]> = {}) => ({
    authorProfile: 'https://github.com/Thomas-Jung', displayName: 'Thomas Jung',
    slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: ['cap'],
    createdAt: '2026-01-01T00:00:00Z', isNew: false, ...o,
  })
  it('groups by lowercased login and excludes unresolvable profiles', () => {
    const idx = buildAuthorIndex(
      [row(), row({ slug: 'b', title: 'B', authorProfile: 'https://github.com/thomas-jung' }),
       row({ slug: 'c', title: 'C', authorProfile: 'mailto:x@y.z' })],
      new Map(),
    )
    expect(Object.keys(idx)).toEqual(['thomas-jung'])
    // Order is covered by the sort test below; here assert the set (both rows
    // share createdAt+title, so grouping order is incidental).
    expect(idx['thomas-jung'].tutorials.map(t => t.slug).sort()).toEqual(['a', 'b'])
  })
  it('sorts tutorials most-recent-first, title tiebreak, and dedupes slugs', () => {
    const idx = buildAuthorIndex(
      [row({ slug: 'old', title: 'Old', createdAt: '2025-01-01T00:00:00Z' }),
       row({ slug: 'new', title: 'New', createdAt: '2026-06-01T00:00:00Z' }),
       row({ slug: 'new', title: 'New dup', createdAt: '2026-06-01T00:00:00Z' })],
      new Map(),
    )
    expect(idx['thomas-jung'].tutorials.map(t => t.slug)).toEqual(['new', 'old'])
  })
  it('sets advocateSlug when the login is an advocate', () => {
    const idx = buildAuthorIndex([row()], new Map([['thomas-jung', 'thomas-jung']]))
    expect(idx['thomas-jung'].advocateSlug).toBe('thomas-jung')
  })
  it('falls back displayName to login when name is missing/Unknown', () => {
    const idx = buildAuthorIndex([row({ displayName: 'Unknown' })], new Map())
    expect(idx['thomas-jung'].displayName).toBe('thomas-jung')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/author-index/build-author-index.test.ts`
Expected: FAIL — cannot resolve `scripts/parsers/author-index`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/parsers/author-index.ts
import { extractGithubLoginFromProfile } from './github-login-from-profile'

export interface AuthorTutorialRow {
  authorProfile: string
  displayName: string
  slug: string
  title: string
  time: number
  level: string
  tags: string[]
  createdAt?: string
  isNew: boolean
}
export interface AuthorIndexTutorial {
  slug: string; title: string; time: number; level: string; tags: string[]; isNew: boolean
}
export interface AuthorIndexEntry {
  login: string; displayName: string; githubUrl: string; advocateSlug?: string
  tutorials: AuthorIndexTutorial[]
}
export type AuthorIndex = Record<string, AuthorIndexEntry>

/** Normalize a frontmatter author_profile URL to a lowercase GitHub login, or null. */
export function normalizeAuthorLogin(profile: unknown): string | null {
  const login = extractGithubLoginFromProfile(profile)
  return login ? login.toLowerCase() : null
}

function niceName(name: string | undefined, login: string): string {
  return name && name !== 'Unknown' ? name : login
}

/** Group tutorial rows by normalized author login. */
export function buildAuthorIndex(
  rows: AuthorTutorialRow[],
  advocates: Map<string, string>,
): AuthorIndex {
  // Sort once up front: most-recent-first, title A→Z tiebreak. Push order = display order.
  const sorted = [...rows].sort((a, b) => {
    const ca = a.createdAt ? Date.parse(a.createdAt) : 0
    const cb = b.createdAt ? Date.parse(b.createdAt) : 0
    if (cb !== ca) return cb - ca
    return a.title.localeCompare(b.title)
  })
  const index: AuthorIndex = {}
  for (const row of sorted) {
    const login = normalizeAuthorLogin(row.authorProfile)
    if (!login) continue
    if (!index[login]) {
      index[login] = {
        login,
        displayName: niceName(row.displayName, login),
        githubUrl: `https://github.com/${login}`,
        ...(advocates.has(login) ? { advocateSlug: advocates.get(login)! } : {}),
        tutorials: [],
      }
    }
    const entry = index[login]
    if (entry.displayName === login) entry.displayName = niceName(row.displayName, login)
    if (entry.tutorials.some((t) => t.slug === row.slug)) continue
    entry.tutorials.push({
      slug: row.slug, title: row.title, time: row.time,
      level: row.level, tags: row.tags, isNew: row.isNew,
    })
  }
  return index
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/author-index/build-author-index.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/author-index.ts test/unit/author-index/build-author-index.test.ts
git commit -m "feat(#1732): pure author-index builder + login normalization"
```

---

### Task 2: Advocate login→slug map from the /api/advocates roster

**Files:**
- Modify: `scripts/parsers/author-index.ts`
- Test: `test/unit/author-index/advocate-login-to-slug.test.ts`

**Interfaces:**
- Produces: `advocateLoginToSlug(roster: unknown): Map<string,string>` — keyed by lowercase login. Prefers the feed's `githubLogin`; falls back to parsing the advocate's `links[]` GitHub URL.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/author-index/advocate-login-to-slug.test.ts
import { describe, it, expect } from 'vitest'
import { advocateLoginToSlug } from '../../../scripts/parsers/author-index'

describe('advocateLoginToSlug', () => {
  it('maps from feed githubLogin (lowercased)', () => {
    const m = advocateLoginToSlug([{ slug: 'thomas-jung', githubLogin: 'Thomas-Jung' }])
    expect(m.get('thomas-jung')).toBe('thomas-jung')
  })
  it('falls back to the GitHub links entry', () => {
    const m = advocateLoginToSlug([
      { slug: 'jane-doe', links: [{ kind: 'GitHub', url: 'https://github.com/JaneD' }] },
    ])
    expect(m.get('janed')).toBe('jane-doe')
  })
  it('ignores advocates with no resolvable login and non-arrays', () => {
    expect(advocateLoginToSlug(null).size).toBe(0)
    expect(advocateLoginToSlug([{ slug: 'x' }]).size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/author-index/advocate-login-to-slug.test.ts`
Expected: FAIL — `advocateLoginToSlug` is not exported.

- [ ] **Step 3: Add the implementation to `scripts/parsers/author-index.ts`**

```ts
/** Build login→advocate-slug from the /api/advocates roster (fail-open shape-tolerant). */
export function advocateLoginToSlug(roster: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(roster)) return map
  for (const a of roster) {
    if (!a || typeof a !== 'object') continue
    const slug = (a as any).slug
    if (!slug) continue
    let login = (a as any).githubLogin
      ? normalizeAuthorLogin(`https://github.com/${(a as any).githubLogin}`)
      : null
    if (!login && Array.isArray((a as any).links)) {
      const gh = (a as any).links.find(
        (l: any) => String(l?.kind).toLowerCase() === 'github' && l?.url,
      )
      if (gh) login = normalizeAuthorLogin(gh.url)
    }
    if (login && !map.has(login)) map.set(login, slug)
  }
  return map
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/author-index/advocate-login-to-slug.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/author-index.ts test/unit/author-index/advocate-login-to-slug.test.ts
git commit -m "feat(#1732): advocate login->slug map builder"
```

---

### Task 3: Surface `githubLogin` on the /api/advocates feed

**Files:**
- Modify: `srv/routes/advocates-public.js` (Users column list ~line 102; `shapeAdvocateRow` ~line 50)
- Test: `test/unit/advocates/shape-advocate-row-githublogin.test.js`

**Interfaces:**
- Produces: `/api/advocates` response rows include `githubLogin` when the linked user has one (omitted otherwise, matching the existing conditional-field style).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/advocates/shape-advocate-row-githublogin.test.js
import { describe, it, expect } from 'vitest'
import { shapeAdvocateRow } from '../../../srv/routes/advocates-public.js'

const baseCtx = (user) => ({
  topicsByAdv: new Map(), linksByAdv: new Map(),
  userById: new Map(user ? [[user.ID, user]] : []),
  authoredByUserId: new Map(), contribByUserId: new Map(),
})

describe('shapeAdvocateRow githubLogin', () => {
  it('includes githubLogin when the linked user has one', () => {
    const a = { ID: 'a1', slug: 'thomas-jung', firstName: 'T', lastName: 'J', user_ID: 'u1' }
    const row = shapeAdvocateRow(a, baseCtx({ ID: 'u1', githubLogin: 'thomas-jung' }))
    expect(row.githubLogin).toBe('thomas-jung')
  })
  it('omits githubLogin when absent', () => {
    const a = { ID: 'a1', slug: 'x', firstName: 'X', lastName: 'Y', user_ID: 'u1' }
    const row = shapeAdvocateRow(a, baseCtx({ ID: 'u1' }))
    expect('githubLogin' in row).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/advocates/shape-advocate-row-githublogin.test.js`
Expected: FAIL — `row.githubLogin` is undefined.

- [ ] **Step 3: Implement**

In `srv/routes/advocates-public.js`, add `githubLogin` to the linked-Users SELECT (around line 101-103):

```js
    userIds.length
      ? db.run(SELECT.from(Users).columns('ID', 'email', 'githubLogin').where({ ID: { in: userIds } }))
      : [],
```

And in `shapeAdvocateRow`, after the `email` spread (around line 50), add:

```js
    ...(linkedUser?.githubLogin ? { githubLogin: linkedUser.githubLogin } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/advocates/shape-advocate-row-githublogin.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/routes/advocates-public.js test/unit/advocates/shape-advocate-row-githublogin.test.js
git commit -m "feat(#1732): surface Users.githubLogin on /api/advocates feed"
```

---

### Task 4: Author-pages writer + wire emission into fetch-tutorials

**Files:**
- Create: `scripts/lib/author-pages-writer.ts`
- Modify: `scripts/fetch-tutorials.ts` (accumulate rows in the `target === 'hugo'` branch ~line 1021; emit after `writeBrowseData` ~line 1319)
- Test: `test/unit/author-index/author-pages-writer.test.ts`

**Interfaces:**
- Consumes: `buildAuthorIndex`, `AuthorTutorialRow` (Task 1); `extractGithubLoginFromProfile`, `browseIsWithinNewWindow`, `getHugoContentDir` (existing in fetch-tutorials).
- Produces: `writeAuthorPages(opts: { rows: AuthorTutorialRow[]; advocates: Map<string,string>; dataFile: string; contentDir: string }): { pagesWritten: number }` — writes the JSON data file and one `.md` per non-advocate login, and prunes stale `.md`.

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/author-index/author-pages-writer.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAuthorPages } from '../../../scripts/lib/author-pages-writer'

const row = (o = {}) => ({
  authorProfile: 'https://github.com/thomas-jung', displayName: 'Thomas Jung',
  slug: 'a', title: 'A', time: 10, level: 'Beginner', tags: [], isNew: false, ...o,
})

describe('writeAuthorPages', () => {
  let dir: string, dataFile: string, contentDir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'authors-'))
    dataFile = join(dir, 'data', 'author_index.json')
    contentDir = join(dir, 'content', 'authors')
  })
  it('writes the index json and a page per non-advocate login', () => {
    const res = writeAuthorPages({
      rows: [row(), row({ slug: 'b', authorProfile: 'https://github.com/jane', displayName: 'Jane' })],
      advocates: new Map([['jane', 'jane-doe']]),
      dataFile, contentDir,
    })
    const idx = JSON.parse(readFileSync(dataFile, 'utf-8'))
    expect(Object.keys(idx).sort()).toEqual(['jane', 'thomas-jung'])
    expect(idx['jane'].advocateSlug).toBe('jane-doe')
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(true)
    expect(existsSync(join(contentDir, 'jane.md'))).toBe(false) // advocate → alias owns route
    expect(res.pagesWritten).toBe(1)
  })
  it('prunes stale author pages', () => {
    mkdirSync(contentDir, { recursive: true })
    writeFileSync(join(contentDir, 'ghost.md'), '---\n---\n')
    writeAuthorPages({ rows: [row()], advocates: new Map(), dataFile, contentDir })
    expect(existsSync(join(contentDir, 'ghost.md'))).toBe(false)
    expect(existsSync(join(contentDir, 'thomas-jung.md'))).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/author-index/author-pages-writer.test.ts`
Expected: FAIL — cannot resolve `scripts/lib/author-pages-writer`.

- [ ] **Step 3: Implement the writer**

```ts
// scripts/lib/author-pages-writer.ts
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { stringify as yamlStringify } from 'yaml'
import { buildAuthorIndex, type AuthorTutorialRow } from '../parsers/author-index'

export function writeAuthorPages(opts: {
  rows: AuthorTutorialRow[]
  advocates: Map<string, string>
  dataFile: string
  contentDir: string
}): { pagesWritten: number } {
  const { rows, advocates, dataFile, contentDir } = opts
  const index = buildAuthorIndex(rows, advocates)

  mkdirSync(dirname(dataFile), { recursive: true })
  writeFileSync(dataFile, JSON.stringify(index, null, 2), 'utf-8')

  mkdirSync(contentDir, { recursive: true })
  const wanted = new Set<string>()
  let pagesWritten = 0
  for (const login of Object.keys(index)) {
    if (index[login].advocateSlug) continue // advocate alias owns /authors/{login}/
    wanted.add(login)
    const fm = yamlStringify({
      title: `Tutorials by ${index[login].displayName}`,
      type: 'authors',
      layout: 'single',
      login,
      slug: login,
    })
    writeFileSync(join(contentDir, `${login}.md`), `---\n${fm}---\n`, 'utf-8')
    pagesWritten++
  }

  if (existsSync(contentDir)) {
    for (const entry of readdirSync(contentDir)) {
      if (entry === '_index.md' || !entry.endsWith('.md')) continue
      const login = entry.replace(/\.md$/, '')
      if (!wanted.has(login)) unlinkSync(join(contentDir, entry))
    }
  }
  return { pagesWritten }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/author-index/author-pages-writer.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire into `scripts/fetch-tutorials.ts`**

Add imports near the other parser imports at the top of the file:

```ts
import { advocateLoginToSlug, type AuthorTutorialRow } from './parsers/author-index'
import { writeAuthorPages } from './lib/author-pages-writer'
```

Declare an accumulator next to where `navEntries` is initialized (before the per-tutorial loop):

```ts
const authorRows: AuthorTutorialRow[] = []
```

Inside the existing `if (target === 'hugo') {` block (currently around line 1021, right after `const githubLogin = ...`), push a row:

```ts
        authorRows.push({
          authorProfile: frontmatter.author_profile ?? '',
          displayName: frontmatter.author_name ?? 'Unknown',
          slug: t.slug,
          title,
          time: frontmatter.time ?? 15,
          level,
          tags: frontmatter.tags ?? [],
          createdAt: createdAt || undefined,
          isNew: browseIsWithinNewWindow(createdAt),
        })
```

Add a fail-open advocate fetch helper (top-level function in the file):

```ts
async function fetchAdvocateRoster(): Promise<unknown[]> {
  try {
    const base = process.env.CAP_BASE_URL || 'http://localhost:4004'
    const res = await fetch(`${base}/api/advocates`)
    if (!res.ok) return []
    const body = await res.json()
    return Array.isArray((body as any)?.advocates) ? (body as any).advocates : []
  } catch (err) {
    console.warn(`  [authors] advocate roster fetch failed (no redirects): ${err instanceof Error ? err.message : err}`)
    return []
  }
}
```

After the `writeBrowseData(...)` block (around line 1319), add the emission:

```ts
  if (target === 'hugo') {
    try {
      const advocates = advocateLoginToSlug(await fetchAdvocateRoster())
      const dataDir = join(__dirname, '..', 'hugo', channel === 'qa' ? 'data-qa' : 'data')
      const { pagesWritten } = writeAuthorPages({
        rows: authorRows,
        advocates,
        dataFile: join(dataDir, 'author_index.json'),
        contentDir: join(getHugoContentDir(channel), 'authors'),
      })
      console.log(`  [authors] wrote author_index.json + ${pagesWritten} author page(s)`)
    } catch (err) {
      console.warn(`  [authors] emit failed: ${err instanceof Error ? err.message : err}`)
    }
  }
```

- [ ] **Step 6: Verify the wiring compiles and the full unit suite is green**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -20` (expect no new errors in the touched files) and `npm test`
Expected: type-check clean for the edited files; unit suite PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/lib/author-pages-writer.ts scripts/fetch-tutorials.ts test/unit/author-index/author-pages-writer.test.ts
git commit -m "feat(#1732): emit author_index.json + author content pages at build time"
```

---

### Task 5: Advocate `aliases` redirect from /authors/{login}/

**Files:**
- Modify: `scripts/fetch-advocates.ts` (`frontmatter()` ~line 54)
- Test: `test/unit/advocates/advocate-author-alias.test.ts`

**Interfaces:**
- Consumes: `normalizeAuthorLogin` (Task 1); advocate `githubLogin` (Task 3) or `links[]`.
- Produces: each advocate whose GitHub login resolves gets `aliases: ['/authors/{login}/']` in its generated front matter, so Hugo emits a redirect stub to `/developer-advocates/{slug}/`.

- [ ] **Step 1: Write the failing test**

Refactor the login resolution into an exported pure helper so it is testable, then assert the front matter.

```ts
// test/unit/advocates/advocate-author-alias.test.ts
import { describe, it, expect } from 'vitest'
import { advocateAuthorLogin } from '../../../scripts/fetch-advocates'

describe('advocateAuthorLogin', () => {
  it('prefers the feed githubLogin', () => {
    expect(advocateAuthorLogin({ githubLogin: 'Thomas-Jung' })).toBe('thomas-jung')
  })
  it('falls back to the GitHub link', () => {
    expect(advocateAuthorLogin({ links: [{ kind: 'GitHub', url: 'https://github.com/JaneD' }] })).toBe('janed')
  })
  it('returns null when unresolvable', () => {
    expect(advocateAuthorLogin({})).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/advocates/advocate-author-alias.test.ts`
Expected: FAIL — `advocateAuthorLogin` not exported.

- [ ] **Step 3: Implement in `scripts/fetch-advocates.ts`**

Add the import and helper near the top:

```ts
import { normalizeAuthorLogin } from './parsers/author-index';

/** Resolve an advocate's canonical GitHub login (lowercase) or null. */
export function advocateAuthorLogin(advocate: any): string | null {
  const fromField = advocate?.githubLogin
    ? normalizeAuthorLogin(`https://github.com/${advocate.githubLogin}`)
    : null;
  if (fromField) return fromField;
  const links = Array.isArray(advocate?.links) ? advocate.links : [];
  const gh = links.find((l: any) => String(l?.kind).toLowerCase() === 'github' && l?.url);
  return gh ? normalizeAuthorLogin(gh.url) : null;
}
```

In `frontmatter()`, after building `fm`, add the alias when a login resolves:

```ts
  const login = advocateAuthorLogin(advocate);
  if (login) fm.aliases = [`/authors/${login}/`];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/advocates/advocate-author-alias.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-advocates.ts test/unit/advocates/advocate-author-alias.test.ts
git commit -m "feat(#1732): redirect /authors/{login} to advocate profile via Hugo alias"
```

---

### Task 6: Author page layout, section index, gitignore, and route guard

**Files:**
- Create: `hugo/layouts/authors/single.html`
- Create: `hugo/content/authors/_index.md`
- Modify: `.gitignore`
- Test: `test/unit/page-key-map-no-authors.test.js`

**Interfaces:**
- Consumes: `site.Data.author_index` (Task 4); `next-steps-card.html` (existing).
- Produces: `/authors/{login}/index.html` static pages; a guard that `/authors/*` never enters `IN_SCOPE_PAGES`.

- [ ] **Step 1: Write the failing route-guard test**

```js
// test/unit/page-key-map-no-authors.test.js
import { describe, it, expect } from 'vitest'
import { IN_SCOPE_PAGES, pageKeyForPath } from '../../srv/lib/page-key-map.js'

describe('/authors/* stays static (never a CAP page key)', () => {
  it('no IN_SCOPE_PAGES route targets /authors', () => {
    expect(IN_SCOPE_PAGES.some((p) => p.route.startsWith('/authors'))).toBe(false)
  })
  it('pageKeyForPath returns null for author routes', () => {
    expect(pageKeyForPath('/authors/thomas-jung/')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it passes immediately (guard, not TDD-red)**

Run: `npx vitest run --project unit test/unit/page-key-map-no-authors.test.js`
Expected: PASS now (this test *locks in* the constraint; it fails only if someone later adds `/authors` to the allowlist).

- [ ] **Step 3: Create the section index that suppresses the /authors/ list page**

```markdown
<!-- hugo/content/authors/_index.md -->
---
title: Authors
_build:
  render: never
  list: never
---
```

- [ ] **Step 4: Create the author page layout**

```html
{{/* hugo/layouts/authors/single.html — static per-author landing page (#1732).
     Data source: hugo/data/author_index.json (emitted by fetch-tutorials). */}}
{{ define "main" }}
{{ $login := .Params.login }}
{{ $entry := "" }}
{{ if and $login site.Data.author_index }}{{ $entry = index site.Data.author_index $login }}{{ end }}
<section class="author-page" data-login="{{ $login }}">
  <a class="author-page-back" href="/browse/">&larr; Browse all tutorials</a>
  {{ with $entry }}
  <header class="author-page-hero">
    <img class="author-page-avatar" src="https://github.com/{{ .login }}.png?size=96"
         width="96" height="96" alt="{{ .displayName }}"
         onerror="this.style.display='none'" />
    <div class="author-page-id">
      <h1>Tutorials by {{ .displayName }}</h1>
      <p class="author-page-meta">
        {{ len .tutorials }} tutorial{{ if ne (len .tutorials) 1 }}s{{ end }}
        &middot; <a href="{{ .githubUrl }}" target="_blank" rel="noopener">GitHub profile</a>
      </p>
    </div>
  </header>
  <div class="next-steps-rail">
    <div class="next-steps-grid">
      {{ range .tutorials }}
      {{ partial "next-steps-card.html" (dict "slug" .slug "title" .title "time" .time) }}
      {{ end }}
    </div>
  </div>
  {{ else }}
  <header class="author-page-hero">
    <h1>Author not found</h1>
    <p><a href="/browse/">Browse all tutorials</a></p>
  </header>
  {{ end }}
</section>
{{ end }}
```

- [ ] **Step 5: Add the gitignore rules (mirror the advocate pattern)**

Add under the existing `hugo/content/developer-advocates/*.md` lines in `.gitignore`:

```gitignore
hugo/content/authors/*.md
!hugo/content/authors/_index.md
```

- [ ] **Step 6: Add minimal author-page CSS**

In the Fundamental Styles source (`hugo/assets/css/sap-fundamental.src.css` — confirm exact path with `git grep -l 'next-steps-rail-heading' hugo/assets`), append:

```css
.author-page { max-width: 72rem; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
.author-page-back { display: inline-block; margin-bottom: 1rem; font-size: .875rem; }
.author-page-hero { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.author-page-avatar { border-radius: 50%; flex: 0 0 auto; }
.author-page-hero h1 { margin: 0 0 .25rem; font-size: 1.5rem; }
.author-page-meta { margin: 0; color: var(--sapContent_LabelColor, #556); font-size: .875rem; }
```

Then rebuild the tracked CSS: `npm run build:css`.

- [ ] **Step 7: Commit**

```bash
git add hugo/layouts/authors/single.html hugo/content/authors/_index.md .gitignore \
        hugo/assets/css/sap-fundamental.src.css hugo/static/css test/unit/page-key-map-no-authors.test.js
git commit -m "feat(#1732): author page layout, section index, route guard, styles"
```

---

### Task 7: Inline "More from this author" rail on tutorial pages

**Files:**
- Create: `hugo/layouts/partials/more-from-author.html`
- Modify: `hugo/layouts/tutorials/u1-object-page.html` (after line 289, inside the Overview section)

**Interfaces:**
- Consumes: `site.Data.author_index` (Task 4); page `.Params.authorProfile`, `.Params.slug`; `next-steps-card.html`.
- Produces: a rail rendered under the author byline, hidden when there are no sibling tutorials or no resolvable login.

- [ ] **Step 1: Create the rail partial**

```html
{{/* hugo/layouts/partials/more-from-author.html — "More from this author" rail (#1732).
     Static, primary-author only. Hidden when no siblings / no resolvable login. */}}
{{- $profile := .Params.authorProfile -}}
{{- $login := "" -}}
{{- if $profile -}}{{- $login = lower (path.Base $profile) -}}{{- end -}}
{{- $entry := "" -}}
{{- if and $login site.Data.author_index -}}{{- $entry = index site.Data.author_index $login -}}{{- end -}}
{{- with $entry -}}
{{- $current := $.Params.slug -}}
{{- $others := where .tutorials "slug" "!=" $current -}}
{{- if gt (len $others) 0 -}}
{{- $target := printf "/authors/%s/" .login -}}
{{- with .advocateSlug -}}{{- $target = printf "/developer-advocates/%s/" . -}}{{- end -}}
<div class="more-from-author next-steps-rail">
  <h4 class="next-steps-rail-heading">More from {{ .displayName }}</h4>
  <div class="next-steps-grid">
    {{- range first 4 $others -}}
    {{ partial "next-steps-card.html" (dict "slug" .slug "title" .title "time" .time) }}
    {{- end -}}
  </div>
  <a class="more-from-author-all" href="{{ $target }}">See all {{ len .tutorials }} tutorials by {{ .displayName }} &rarr;</a>
</div>
{{- end -}}
{{- end -}}
```

- [ ] **Step 2: Invoke it from the object-page Overview section**

In `hugo/layouts/tutorials/u1-object-page.html`, immediately after line 289 (`{{ partial "tutorial-author.html" . }}`), add:

```html
          {{ if not site.Params.previewMode }}{{ partial "more-from-author.html" . }}{{ end }}
```

- [ ] **Step 3: Add rail CSS**

Append to the same CSS source touched in Task 6:

```css
.more-from-author { margin: 1.25rem 0 0; }
.more-from-author-all { display: inline-block; margin-top: .75rem; font-size: .875rem; font-weight: 600; }
```

Rebuild: `npm run build:css`.

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/partials/more-from-author.html hugo/layouts/tutorials/u1-object-page.html \
        hugo/assets/css/sap-fundamental.src.css hugo/static/css
git commit -m "feat(#1732): inline more-from-author rail on tutorial pages"
```

---

### Task 8: Point the author byline at the internal author/advocate page

**Files:**
- Modify: `hugo/layouts/partials/tutorial-author.html` (name link, lines 42-46)

**Interfaces:**
- Consumes: `site.Data.author_index`, page `.Params.authorProfile`.
- Produces: author name links to `/authors/{login}/` (or `/developer-advocates/{slug}/` for advocates) when resolvable; otherwise unchanged (GitHub / plain span). Avatar link to GitHub is left intact.

- [ ] **Step 1: Replace the name-link block (lines 42-46)**

```html
    {{ $authorLogin := "" }}
    {{ if $authorProfile }}{{ $authorLogin = lower (path.Base $authorProfile) }}{{ end }}
    {{ $authorEntry := "" }}
    {{ if and $authorLogin site.Data.author_index }}{{ $authorEntry = index site.Data.author_index $authorLogin }}{{ end }}
    {{ if $authorEntry }}
    {{ $authorHref := printf "/authors/%s/" $authorLogin }}
    {{ with $authorEntry.advocateSlug }}{{ $authorHref = printf "/developer-advocates/%s/" . }}{{ end }}
    <a href="{{ $authorHref }}" class="author-line-name">{{ $displayName }}</a>
    {{ else if $displayLogin }}
    <a href="https://github.com/{{ $displayLogin }}" class="author-line-name" target="_blank" rel="noopener">{{ $displayName }}</a>
    {{ else }}
    <span class="author-line-name">{{ $displayName }}</span>
    {{ end }}
```

- [ ] **Step 2: Commit**

```bash
git add hugo/layouts/partials/tutorial-author.html
git commit -m "feat(#1732): link author byline to internal author/advocate page"
```

---

### Task 9: Integration build + real-output verification (Tom's #1 rule)

**Files:** none (verification task). Requires `CAP_BASE_URL` pointed at deployed DEV so the CAP + advocate feeds are populated.

- [ ] **Step 1: Fetch + build against DEV**

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run fetch-tutorials
```
Expected: console shows `[authors] wrote author_index.json + N author page(s)` and `hugo/data/author_index.json` exists and is non-empty (`jq 'keys | length' hugo/data/author_index.json` > 0).

- [ ] **Step 2: Build Hugo and inspect a real author page**

```bash
npm run build:hugo
# pick a login that has ≥2 tutorials:
LOGIN=$(jq -r 'to_entries | map(select(.value.tutorials|length >= 2)) | .[0].key' hugo/data/author_index.json)
echo "login=$LOGIN"
test -f "hugo/public/authors/$LOGIN/index.html" && echo "author page built"
grep -c 'next-steps-card' "hugo/public/authors/$LOGIN/index.html"   # expect >= 2
```
Expected: the author page exists and contains the tutorial cards.

- [ ] **Step 3: Confirm the rail is baked into a tutorial page by that author**

```bash
SLUG=$(jq -r --arg l "$LOGIN" '.[$l].tutorials[0].slug' hugo/data/author_index.json)
grep -c 'more-from-author' "hugo/public/tutorials/$SLUG/index.html"   # expect 1
```
Expected: the rail markup is present in the built tutorial HTML.

- [ ] **Step 4: Confirm advocate redirect (if any advocate authors exist)**

```bash
ADV=$(jq -r 'to_entries | map(select(.value.advocateSlug)) | .[0].key // empty' hugo/data/author_index.json)
if [ -n "$ADV" ]; then
  test -f "hugo/public/authors/$ADV/index.html" && grep -qi 'refresh\|window.location' "hugo/public/authors/$ADV/index.html" \
    && echo "advocate alias stub present" || echo "CHECK: no alias stub for advocate $ADV"
fi
```
Expected: for an advocate author, `/authors/{login}/` is a Hugo redirect stub to `/developer-advocates/{slug}/` (no standalone listing page).

- [ ] **Step 5: Commit (only if any tracked build artifacts changed, e.g. CSS)**

```bash
git add -A && git commit -m "chore(#1732): rebuild artifacts for author pages" || echo "nothing to commit"
```

---

### Task 10: Post-deploy e2e spec (advisory)

**Files:**
- Create: `test/e2e/other-tutorials-by-author.spec.ts`

**Interfaces:**
- Consumes: `SMOKE_BASE_URL`/`PLAYWRIGHT_BASE_URL` (self-skips when absent, like the other specs in `test/e2e/`).

- [ ] **Step 1: Write the spec (models `test/e2e/README.md` conventions)**

```ts
// test/e2e/other-tutorials-by-author.spec.ts
import { test, expect } from '@playwright/test'

const BASE = process.env.PLAYWRIGHT_BASE_URL || process.env.SMOKE_BASE_URL

test.describe('other tutorials by author (#1732)', () => {
  test.skip(!BASE, 'no SMOKE_BASE_URL/PLAYWRIGHT_BASE_URL configured')

  test('author page lists tutorials', async ({ page, request }) => {
    // Discover a login with >= 2 tutorials from the built data file served statically.
    const res = await request.get(`${BASE}/data/author_index.json`).catch(() => null)
    test.skip(!res || !res.ok(), 'author_index.json not served at this host')
    const idx = await res!.json()
    const login = Object.keys(idx).find((k) => !idx[k].advocateSlug && idx[k].tutorials.length >= 2)
    test.skip(!login, 'no non-advocate author with >= 2 tutorials')
    await page.goto(`${BASE}/authors/${login}/`)
    await expect(page.locator('.author-page h1')).toContainText('Tutorials by')
    expect(await page.locator('.next-steps-rail-card, .next-steps-card').count()).toBeGreaterThanOrEqual(2)
  })

  test('tutorial page shows the more-from-author rail', async ({ page, request }) => {
    const res = await request.get(`${BASE}/data/author_index.json`).catch(() => null)
    test.skip(!res || !res.ok(), 'author_index.json not served at this host')
    const idx = await res!.json()
    const login = Object.keys(idx).find((k) => idx[k].tutorials.length >= 2)
    test.skip(!login, 'no author with >= 2 tutorials')
    const slug = idx[login].tutorials[0].slug
    await page.goto(`${BASE}/tutorials/${slug}`)
    await expect(page.locator('.more-from-author')).toBeVisible()
  })
})
```

Note: `/data/author_index.json` is served statically by the approuter catch-all (same mechanism as the pages), so the spec can self-discover fixtures. If the host does not serve it, the spec self-skips.

- [ ] **Step 2: Commit**

```bash
git add test/e2e/other-tutorials-by-author.spec.ts
git commit -m "test(#1732): post-deploy e2e for author page + rail"
```

---

## Self-Review

**Spec coverage:**
- Inline rail → Task 7. Author page → Task 6. Both surfaces fed by one `author_index.json` → Task 4. ✓
- Static serving / `/authors/*` off allowlist → Global Constraints + Task 6 guard. ✓
- Primary-author-only grouping → Task 1. ✓
- Advocate redirect + login→slug map → Tasks 2, 3, 5. ✓
- QA `data-qa` parity → Task 4 (channel-aware `dataDir` + `getHugoContentDir(channel)`). ✓
- Byline links internal → Task 8. ✓
- Fail-open advocate fetch → Task 4 helper. ✓
- Gitignore generated pages → Task 6. ✓
- Known-limitation (static staleness) requires no task (documented in spec). ✓
- Testing: units (1-5), guard (6), integration build (9), e2e (10). ✓

**Placeholder scan:** No TBD/TODO; every code step has real content. One path to confirm at execution time: the CSS source filename (`hugo/assets/css/sap-fundamental.src.css`) — Task 6 Step 6 gives the `git grep` to confirm it. Not a blocker.

**Type consistency:** `AuthorTutorialRow`/`AuthorIndex*` names are consistent across Tasks 1/4; `advocateLoginToSlug` (Task 2) and `advocateAuthorLogin` (Task 5) both return lowercase logins consistent with `normalizeAuthorLogin`; `writeAuthorPages` signature matches its call site in Task 4. ✓
