/**
 * Reserved GitHub path segments that cannot be a user login.
 * Hand-maintained list; no upstream npm package exports this set.
 * See https://docs.github.com/en/github/getting-started-with-github/reserved-usernames
 */
const RESERVED = new Set([
  'settings', 'marketplace', 'pricing', 'about', 'features', 'security',
  'enterprise', 'team', 'collections', 'topics', 'trending', 'login',
  'logout', 'join', 'sponsors', 'orgs', 'organizations', 'codespaces',
  'notifications', 'pulls', 'issues', 'explore', 'new', 'search',
])

export function extractGithubLoginFromProfile(profile: unknown): string | null {
  if (typeof profile !== 'string') return null
  const s = profile.trim()
  if (s.length === 0) return null

  // Tolerate missing scheme.
  const normalized = /^https?:\/\//i.test(s) ? s : `https://${s}`

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    return null
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '')
  if (host !== 'github.com') return null

  const seg = url.pathname.split('/').filter(Boolean)[0]
  if (!seg) return null
  if (RESERVED.has(seg.toLowerCase())) return null

  // GitHub login: 1-39 chars, alnum or hyphen, no leading/trailing hyphen.
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(seg)) return null
  return seg
}
