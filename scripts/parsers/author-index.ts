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
  /**
   * #1758: top git-contributor login for this tutorial (raw GitHub login, any
   * case). Used only as a fallback when `authorProfile` is absent — and then
   * only to attach the tutorial to an author page that ALREADY exists (see
   * buildAuthorIndex). Never mints a new author page.
   */
  topContributorLogin?: string
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

/** Group tutorial rows by normalized author login. */
export function buildAuthorIndex(
  rows: AuthorTutorialRow[],
  advocates: Map<string, string>,
  activeSlugs?: Set<string>,
): AuthorIndex {
  // Sort once up front: most-recent-first, title A→Z tiebreak. Push order = display order.
  const sorted = [...rows].sort((a, b) => {
    const ca = a.createdAt ? Date.parse(a.createdAt) : 0
    const cb = b.createdAt ? Date.parse(b.createdAt) : 0
    if (cb !== ca) return cb - ca
    return a.title.localeCompare(b.title)
  })
  // Row passes the active/published filter? Fail-open when no set is provided
  // (degraded / ALLOW_EMPTY_CAP builds pass empty/undefined → no filtering).
  const isActive = (row: AuthorTutorialRow) =>
    !activeSlugs || activeSlugs.size === 0 || activeSlugs.has(row.slug.toLowerCase())

  // #1758 (conservative fallback): logins that HAVE an author page — i.e. that
  // resolved via `authorProfile` on at least one ACTIVE tutorial. A
  // contributor-only tutorial is attached to its top-contributor login only
  // when that login is in this set, so we never mint a page from a git
  // contributor (bots, typo-fixers, reviewers). Established-only keeps
  // attribution semantics unchanged for everyone without an existing page.
  const established = new Set<string>()
  for (const row of sorted) {
    if (!isActive(row)) continue
    const login = normalizeAuthorLogin(row.authorProfile)
    if (login) established.add(login)
  }

  // Effective author login for a row: the authorProfile login, else the top
  // git-contributor login IF that login already has an author page.
  const effectiveLogin = (row: AuthorTutorialRow): string | null => {
    const login = normalizeAuthorLogin(row.authorProfile)
    if (login) return login
    const contrib = row.topContributorLogin ? row.topContributorLogin.toLowerCase() : ''
    return contrib && established.has(contrib) ? contrib : null
  }

  const index: AuthorIndex = {}
  for (const row of sorted) {
    const login = effectiveLogin(row)
    if (!login) continue
    // Exclude tutorials not in the active/published catalog: INACTIVE /
    // soft-deleted tutorials, and stale .tutorial-cache entries for slugs
    // deleted from the source repo. activeSlugs is the ACTIVE-only catalog slug
    // set (status='ACTIVE' or null — srv/lib/build-catalog.js) that the main
    // navigator/browse pipeline already uses. Without this the author pages +
    // "more from author" rail surfaced unpublished/deleted tutorials.
    // Fail-open: only filter when a non-empty set was provided (degraded /
    // ALLOW_EMPTY_CAP builds pass empty/undefined → no filtering). Compare
    // lowercase — row slugs come from mixed-case source dirs, catalog slugs are
    // lowercase-canonical (see CLAUDE.md slug-casing rule).
    if (!isActive(row)) continue
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
