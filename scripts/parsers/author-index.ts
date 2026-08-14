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
