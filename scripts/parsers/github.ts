import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', '.tutorial-cache')
const CACHE_FILE = join(CACHE_DIR, 'github-meta.v2.json')
const DISCOVERY_CACHE_FILE = join(CACHE_DIR, '_discovery.json')
// Committed snapshot beside this file. Tier 2 falls back to it when the
// gitignored runtime cache is wiped (e.g. fresh clone, `rm -rf .tutorial-cache/`)
// during a GitHub outage. Refreshed by saveDiscoveryBaseline() on successful
// GraphQL fetches; stale baseline is acceptable — it only loads when GitHub is unreachable.
const DISCOVERY_BASELINE_FILE = join(__dirname, 'discovery-baseline.json')
const ORG = 'sap-tutorials'
const GRAPHQL_URL = 'https://api.github.com/graphql'
const REST_API_BASE = 'https://api.github.com'
const BATCH_SIZE = 20

// Retry policy: 8 attempts, exponential backoff with jitter, capped at 60s.
// GitHub incidents are typically <30 min, so total max wait of ~5 min covers most.
const MAX_RETRIES = 8
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

export const EXCLUDED_REPOS = new Set(['tutorials-ims'])

// Private repos that SHOULD be discovered + fetched despite being non-public.
// `meta-tutorials` contains showcase tutorials demonstrating platform features
// for authors (CODECHECK_N, VALIDATE_N AI grading, AUTOAUTHOR_*, mermaid,
// codetabs, glossary, lightbox, etc.). The repo is private but the content
// is intended for tutorial-author consumption — we keep it private to gate
// it behind an SAP-internal audience while still surfacing it on the
// platform. -Contribution repos are also private but excluded by name
// pattern; INCLUDED_PRIVATE_REPOS is a separate concept (allowlist for
// non-Contribution private repos).
export const INCLUDED_PRIVATE_REPOS = new Set(['meta-tutorials'])

export interface GitHubContributor {
  name: string
  login: string
  email: string
  avatarUrl: string
}

export interface GitHubMeta {
  lastUpdated: string
  createdAt: string
  lastCommitSha: string
  contributors: GitHubContributor[]
}

export interface DiscoveredTutorial {
  slug: string
  repo: string
  branch: string
}

type CacheData = Record<string, GitHubMeta>

function loadCache(): CacheData {
  if (existsSync(CACHE_FILE)) {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
  }
  return {}
}

function saveCache(data: CacheData) {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

function slugToAlias(slug: string): string {
  return 't_' + slug.replace(/[^a-zA-Z0-9]/g, '_')
}

function aliasToSlug(alias: string, slugs: string[]): string | undefined {
  return slugs.find(s => slugToAlias(s) === alias)
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_DELAY_MS)
  const dateMs = Date.parse(header)
  if (Number.isNaN(dateMs)) return null
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_DELAY_MS)
}

function backoffDelay(attempt: number): number {
  // attempt is 1-indexed; first retry uses BASE_DELAY_MS
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
  const jitter = Math.floor(Math.random() * 500)
  return exp + jitter
}

interface GraphqlRequestOptions {
  retries?: number
  // When true, surface 5xx as Transient5xxError so caller can degrade page size.
  // See FetchWithRetryOptions.failFastOn5xx.
  failFastOn5xx?: boolean
}

async function graphqlRequest(query: string, opts: GraphqlRequestOptions = {}): Promise<any> {
  const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN is required for GraphQL API')

  const res = await fetchWithRetry(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'tutorials-poc-build',
    },
    body: JSON.stringify({ query }),
  }, { retries: opts.retries ?? MAX_RETRIES, label: 'graphql', failFastOn5xx: opts.failFastOn5xx })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`GraphQL request failed: ${res.status} ${body}`)
  }

  const json = await res.json()
  if (json.errors?.length) {
    const msgs = json.errors.map((e: any) => e.message).join('; ')
    console.warn(`  [graphql-warn] ${msgs}`)
  }
  return json.data
}

function restAuthHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN is required for REST API')
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tutorials-poc-build',
  }
}

async function restApiRequest<T = any>(path: string): Promise<T | null> {
  const url = path.startsWith('http') ? path : `${REST_API_BASE}${path}`
  const res = await fetchWithRetry(url, { headers: restAuthHeaders() }, { label: 'rest' })
  if (res.status === 404) return null
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`REST ${path} failed: ${res.status} ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

async function restApiPaginated<T = any>(initialPath: string): Promise<T[]> {
  let next: string | null = initialPath
  const all: T[] = []
  while (next) {
    const url: string = next.startsWith('http') ? next : `${REST_API_BASE}${next}`
    const res = await fetchWithRetry(url, { headers: restAuthHeaders() }, { label: 'rest' })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`REST ${initialPath} failed: ${res.status} ${body.slice(0, 200)}`)
    }
    const items = await res.json() as T[]
    if (Array.isArray(items)) all.push(...items)

    // Parse Link header for rel="next"
    const linkHeader = res.headers.get('link') ?? ''
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/)
    next = nextMatch ? nextMatch[1] : null
  }
  return all
}

export interface FetchWithRetryOptions {
  retries?: number
  label?: string
  // When true, 5xx responses throw Transient5xxError immediately with no retry,
  // so the caller can degrade (e.g., shrink GraphQL page size) instead of burning
  // the full retry chain on identical heavy payloads. Network errors and 429 still
  // retry normally — those are network/budget signals, not complexity signals.
  failFastOn5xx?: boolean
}

// Thrown by fetchWithRetry when failFastOn5xx is set and the server returns 5xx.
// Callers catch this to degrade their request shape (smaller page, narrower query)
// rather than reissuing the same heavy payload that just timed out.
export class Transient5xxError extends Error {
  constructor(public status: number, public label: string) {
    super(`${label} returned ${status}`)
    this.name = 'Transient5xxError'
  }
}

// Generic retry wrapper around fetch().
// Retries on 5xx, 429, and network errors with exponential backoff and jitter.
// Honors Retry-After. Fails fast on other 4xx (404 should not be retried).
// Returns the final Response — caller is responsible for reading the body.
export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? MAX_RETRIES
  const label = opts.label ?? 'fetch'
  const failFastOn5xx = opts.failFastOn5xx ?? false
  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries) {
        const wait = backoffDelay(attempt)
        console.warn(`  [${label}] network error on attempt ${attempt}/${retries}: ${lastError.message}; retrying in ${Math.round(wait / 1000)}s...`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      break
    }

    if (res.status >= 500 && failFastOn5xx) {
      throw new Transient5xxError(res.status, label)
    }

    const retryable = res.status >= 500 || res.status === 429
    if (retryable && attempt < retries) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
      const wait = retryAfter ?? backoffDelay(attempt)
      console.warn(`  [${label}] ${res.status} on attempt ${attempt}/${retries}, retrying in ${Math.round(wait / 1000)}s...`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }

    return res
  }

  throw new Error(`${label} request failed after ${retries} attempts${lastError ? `: ${lastError.message}` : ''}`)
}

function loadDiscoveryCache(): DiscoveredTutorial[] | null {
  const fromRuntime = tryLoadDiscoveryFile(DISCOVERY_CACHE_FILE)
  if (fromRuntime) return fromRuntime

  const fromBaseline = tryLoadDiscoveryFile(DISCOVERY_BASELINE_FILE)
  if (fromBaseline) {
    console.warn(`  [baseline] Runtime cache missing; using committed baseline (${fromBaseline.length} tutorials, ${DISCOVERY_BASELINE_FILE})`)
    console.warn(`  [baseline] Baseline may be stale — re-run when GitHub recovers and commit any diff to refresh.`)
  }
  return fromBaseline
}

function tryLoadDiscoveryFile(path: string): DiscoveredTutorial[] | null {
  if (!existsSync(path)) return null
  try {
    const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, DiscoveredTutorial>
    const tutorials = Object.values(map).filter(
      (t): t is DiscoveredTutorial =>
        !!t && typeof t.slug === 'string' && typeof t.repo === 'string' && typeof t.branch === 'string',
    )
    return tutorials.length > 0 ? tutorials : null
  } catch {
    return null
  }
}

// Refreshes the committed baseline snapshot. Idempotent: only writes when
// content actually differs (sorted by slug to avoid pagination-order churn).
// Caller is responsible for gating on a fresh source — never call from disk/hana fallbacks.
export function saveDiscoveryBaseline(tutorials: DiscoveredTutorial[]): void {
  const sorted: Record<string, DiscoveredTutorial> = {}
  for (const slug of [...tutorials.map(t => t.slug)].sort()) {
    const t = tutorials.find(x => x.slug === slug)
    if (t) sorted[slug] = t
  }
  const next = JSON.stringify(sorted, null, 2) + '\n'
  if (existsSync(DISCOVERY_BASELINE_FILE)) {
    const current = readFileSync(DISCOVERY_BASELINE_FILE, 'utf-8')
    if (current === next) return
  }
  writeFileSync(DISCOVERY_BASELINE_FILE, next, 'utf-8')
  console.log(`  [baseline] Updated ${DISCOVERY_BASELINE_FILE} (${tutorials.length} tutorials) — commit this diff to refresh the snapshot`)
}

async function loadDiscoveryFromHana(): Promise<DiscoveredTutorial[] | null> {
  const baseUrl = process.env.CAP_BASE_URL
  if (!baseUrl) {
    console.warn(`  [hana] CAP_BASE_URL not set; Tier 3 (HANA RepoCatalog) fallback unavailable.`)
    console.warn(`  [hana] Export CAP_BASE_URL=<deployed CAP srv URL> to enable this fallback during GitHub outages.`)
    return null
  }
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/build/repo-catalog`, {
      headers: { 'User-Agent': 'tutorials-poc-build' },
    })
    if (!res.ok) return null
    const map = await res.json() as Record<string, DiscoveredTutorial>
    const tutorials = Object.values(map).filter(
      (t): t is DiscoveredTutorial =>
        !!t && typeof t.slug === 'string' && typeof t.repo === 'string' && typeof t.branch === 'string',
    )
    return tutorials.length > 0 ? tutorials : null
  } catch {
    return null
  }
}

export async function uploadDiscoveryToHana(tutorials: DiscoveredTutorial[]): Promise<void> {
  const baseUrl = process.env.CAP_BASE_URL
  const apiKey = process.env.CONTENT_API_KEY
  if (!baseUrl || !apiKey) return
  const entries: Record<string, DiscoveredTutorial> = {}
  for (const t of tutorials) entries[t.slug] = t
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/build/repo-catalog`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'tutorials-poc-build',
      },
      body: JSON.stringify({ entries }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`  [repo-catalog] HANA upload failed: ${res.status} ${body.slice(0, 200)}`)
      return
    }
    console.log(`  [repo-catalog] uploaded ${tutorials.length} entries to HANA`)
  } catch (err) {
    console.warn(`  [repo-catalog] HANA upload error: ${err instanceof Error ? err.message : err}`)
  }
}

export type DiscoverySource = 'github' | 'rest' | 'disk' | 'hana'

export interface DiscoveryResult {
  tutorials: DiscoveredTutorial[]
  source: DiscoverySource
}

export async function discoverAllTutorials(): Promise<DiscoveryResult> {
  try {
    const tutorials = await discoverFromGitHub()
    return { tutorials, source: 'github' }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`\n  [graphql] Discovery failed (${message})`)

    try {
      console.warn(`  [rest] Attempting REST API discovery fallback...`)
      const tutorials = await discoverFromRest()
      if (tutorials.length > 0) {
        console.warn(`  [rest] Discovered ${tutorials.length} tutorials via REST API\n`)
        return { tutorials, source: 'rest' }
      }
      console.warn(`  [rest] REST discovery returned no tutorials; falling through.`)
    } catch (restErr) {
      const restMessage = restErr instanceof Error ? restErr.message : String(restErr)
      console.warn(`  [rest] REST discovery failed (${restMessage}); falling through.`)
    }

    const cached = loadDiscoveryCache()
    if (cached) {
      console.warn(`  [graphql] Falling back to local disk cache (${cached.length} tutorials, ${DISCOVERY_CACHE_FILE})`)
      console.warn(`  [graphql] Cache may be stale — re-run later when GitHub recovers to refresh.\n`)
      return { tutorials: cached, source: 'disk' }
    }

    const fromHana = await loadDiscoveryFromHana()
    if (fromHana) {
      console.warn(`  [graphql] Local cache empty; falling back to HANA RepoCatalog (${fromHana.length} tutorials)`)
      console.warn(`  [graphql] Catalog may be stale — re-run later when GitHub recovers to refresh.\n`)
      return { tutorials: fromHana, source: 'hana' }
    }

    throw err
  }
}

async function discoverFromGitHub(): Promise<DiscoveredTutorial[]> {
  const includeContribution = process.env.INCLUDE_CONTRIBUTION_REPOS === 'true'
  const onlyContribution = process.env.ONLY_CONTRIBUTION_REPOS === 'true'
  const tutorials: DiscoveredTutorial[] = []
  let cursor: string | null = null
  let page = 0

  // Adaptive page size: halved on each 5xx, restoring on success after a degrade.
  // Starts at 50 (half of GitHub's 100 max) — a balance between throughput and
  // complexity-per-call. Floor of 5 keeps progress possible during prolonged outages
  // before the chain falls through to REST/disk/HANA tiers.
  const INITIAL_PAGE_SIZE = 50
  const MIN_PAGE_SIZE = 5
  let pageSize = INITIAL_PAGE_SIZE

  while (true) {
    page++
    const afterClause = cursor ? `, after: "${cursor}"` : ''
    const query = `{
      organization(login: "${ORG}") {
        repositories(first: ${pageSize}${afterClause}, orderBy: {field: NAME, direction: ASC}) {
          nodes {
            name
            isArchived
            isDisabled
            isFork
            isPrivate
            defaultBranchRef { name }
            tutorials: object(expression: "HEAD:tutorials") {
              ... on Tree {
                entries { name type }
              }
            }
          }
          pageInfo { endCursor hasNextPage }
        }
      }
      rateLimit { cost remaining limit resetAt }
    }`

    console.log(`  [graphql] Discovering repos (page ${page}, first:${pageSize})...`)
    let data: any
    try {
      data = await graphqlRequest(query, { failFastOn5xx: true })
    } catch (err) {
      if (err instanceof Transient5xxError && pageSize > MIN_PAGE_SIZE) {
        const next = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2))
        console.warn(`  [graphql] ${err.status} on page ${page} (first:${pageSize}); halving to first:${next} and resuming from same cursor`)
        pageSize = next
        page-- // retry as same page number
        continue
      }
      throw err
    }
    const repos = data.organization.repositories

    if (data.rateLimit) {
      const { cost, remaining, limit, resetAt } = data.rateLimit
      console.log(`  [graphql] page ${page} cost=${cost} remaining=${remaining}/${limit} resetAt=${resetAt}`)
    }

    for (const repo of repos.nodes) {
      if (repo.isArchived || repo.isDisabled || repo.isFork) continue
      if (EXCLUDED_REPOS.has(repo.name)) continue
      // Private repos: include only if explicitly allowlisted OR if they're
      // a -Contribution repo (handled by the next filter). This keeps
      // organization-private repos out of the build by default while still
      // letting us surface targeted ones like meta-tutorials.
      if (repo.isPrivate && !INCLUDED_PRIVATE_REPOS.has(repo.name) && !repo.name.endsWith('-Contribution')) continue
      if (onlyContribution) {
        // QA channel: only -Contribution repos (inverse of prod filter).
        if (!repo.name.endsWith('-Contribution')) continue
      } else if (!includeContribution && repo.name.endsWith('-Contribution')) {
        continue
      }
      const branch = repo.defaultBranchRef?.name
      if (!branch) continue

      const tree = repo.tutorials
      if (!tree?.entries) continue

      const dirs = tree.entries.filter((e: any) => e.type === 'tree')
      if (dirs.length > 0) {
        console.log(`  ${repo.name} (${branch}): ${dirs.length} tutorials`)
        for (const dir of dirs) {
          tutorials.push({ slug: dir.name, repo: repo.name, branch })
        }
      }
    }

    if (!repos.pageInfo.hasNextPage) break
    cursor = repos.pageInfo.endCursor
  }

  return tutorials
}

interface RestRepoMeta {
  name: string
  archived?: boolean
  disabled?: boolean
  fork?: boolean
  private?: boolean
  default_branch?: string
}

interface RestContentEntry {
  name: string
  type: string
}

export async function discoverFromRest(): Promise<DiscoveredTutorial[]> {
  const includeContribution = process.env.INCLUDE_CONTRIBUTION_REPOS === 'true'
  const onlyContribution = process.env.ONLY_CONTRIBUTION_REPOS === 'true'
  console.log(`  [rest] Listing repos in ${ORG}...`)
  // type=all (was: type=public) to allow discovery of allowlisted private
  // repos like meta-tutorials. Private repos are filtered post-fetch via
  // INCLUDED_PRIVATE_REPOS (mirror of the GraphQL path's check).
  const repos = await restApiPaginated<RestRepoMeta>(`/orgs/${ORG}/repos?per_page=100&type=all`)

  const tutorials: DiscoveredTutorial[] = []
  for (const repo of repos) {
    if (repo.archived || repo.disabled || repo.fork) continue
    if (EXCLUDED_REPOS.has(repo.name)) continue
    if (repo.private && !INCLUDED_PRIVATE_REPOS.has(repo.name) && !repo.name.endsWith('-Contribution')) continue
    if (onlyContribution) {
      if (!repo.name.endsWith('-Contribution')) continue
    } else if (!includeContribution && repo.name.endsWith('-Contribution')) {
      continue
    }
    const branch = repo.default_branch
    if (!branch) continue

    let entries: RestContentEntry[] | null
    try {
      entries = await restApiRequest<RestContentEntry[]>(
        `/repos/${ORG}/${repo.name}/contents/tutorials?ref=${encodeURIComponent(branch)}`,
      )
    } catch (err) {
      console.warn(`  [rest] ${repo.name}: contents fetch failed (${err instanceof Error ? err.message : err}); skipping`)
      continue
    }
    if (!entries || !Array.isArray(entries)) continue

    const dirs = entries.filter(e => e.type === 'dir')
    if (dirs.length > 0) {
      console.log(`  [rest] ${repo.name} (${branch}): ${dirs.length} tutorials`)
      for (const dir of dirs) {
        tutorials.push({ slug: dir.name, repo: repo.name, branch })
      }
    }
  }

  return tutorials
}

interface RestCommit {
  sha: string
  commit?: { author?: { name?: string; date?: string; email?: string } }
  author?: { login?: string; avatar_url?: string } | null
}

export async function fetchMetaFromRest(repo: string, slug: string, branch: string): Promise<GitHubMeta | null> {
  const path = `tutorials/${slug}/${slug}.md`
  let commits: RestCommit[] | null
  try {
    commits = await restApiRequest<RestCommit[]>(
      `/repos/${ORG}/${repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=30`,
    )
  } catch {
    return null
  }
  if (!commits || commits.length === 0) return null

  const lastCommitSha = commits[0].sha ?? ''
  const lastUpdated = commits[0].commit?.author?.date ?? ''
  const createdAt = commits[commits.length - 1].commit?.author?.date ?? ''

  const seen = new Set<string>()
  const contributors: GitHubContributor[] = []
  for (const c of commits) {
    const login = c.author?.login ?? ''
    if (!login || seen.has(login)) continue
    seen.add(login)
    contributors.push({
      name: c.commit?.author?.name ?? login,
      login,
      email: c.commit?.author?.email ?? '',
      avatarUrl: c.author?.avatar_url ?? '',
    })
  }

  return { lastCommitSha, lastUpdated, createdAt, contributors }
}

export async function fetchContributorsFromRestContrib(
  repo: string,
  slug: string,
  branch: string,
): Promise<GitHubContributor[] | null> {
  const contribRepo = repo.endsWith('-Contribution') ? repo : `${repo}-Contribution`
  let commits: RestCommit[] | null
  try {
    commits = await restApiRequest<RestCommit[]>(
      `/repos/${ORG}/${contribRepo}/commits?path=${encodeURIComponent(`tutorials/${slug}`)}&sha=${encodeURIComponent(branch)}&per_page=50`,
    )
  } catch {
    return null
  }
  if (!commits || commits.length === 0) return null

  const seen = new Set<string>()
  const contributors: GitHubContributor[] = []
  for (const c of commits) {
    const login = c.author?.login ?? ''
    if (!login || seen.has(login)) continue
    seen.add(login)
    contributors.push({
      name: c.commit?.author?.name ?? login,
      login,
      email: c.commit?.author?.email ?? '',
      avatarUrl: c.author?.avatar_url ?? '',
    })
  }
  return contributors.length > 0 ? contributors : null
}

export function extractContributors(nodes: any[]): GitHubContributor[] {
  const seen = new Set<string>()
  const contributors: GitHubContributor[] = []
  for (const node of nodes) {
    const login = node.author?.user?.login ?? ''
    if (!login || seen.has(login)) continue
    seen.add(login)
    contributors.push({
      name: node.author?.name ?? login,
      login,
      email: node.author?.email ?? '',
      avatarUrl: node.author?.user?.avatarUrl ?? '',
    })
  }
  return contributors
}

async function fetchContributorsFromContribRepo(
  repo: string,
  slugs: string[],
): Promise<Map<string, GitHubContributor[]>> {
  const contribRepo = repo.endsWith('-Contribution') ? repo : `${repo}-Contribution`
  const results = new Map<string, GitHubContributor[]>()

  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE)
    const historyFields = batch.map(slug => {
      const alias = slugToAlias(slug)
      const path = `tutorials/${slug}`
      return `${alias}: history(first: 50, path: "${path}") {
        nodes {
          author {
            name
            email
            user { login avatarUrl }
          }
        }
      }`
    }).join('\n            ')

    const query = `{
      repository(owner: "${ORG}", name: "${contribRepo}") {
        defaultBranchRef {
          target {
            ... on Commit {
              ${historyFields}
            }
          }
        }
      }
    }`

    try {
      const data = await graphqlRequest(query)
      const commit = data.repository?.defaultBranchRef?.target
      if (!commit) continue

      for (const [alias, historyData] of Object.entries(commit) as Array<[string, any]>) {
        if (alias === '__typename') continue
        const slug = aliasToSlug(alias, batch)
        if (!slug) continue
        const nodes = historyData?.nodes ?? []
        if (nodes.length > 0) {
          results.set(slug, extractContributors(nodes))
        }
      }
    } catch {
      // -Contribution repo may not exist or be inaccessible — that's fine
    }
  }

  return results
}

export async function fetchGitHubMetaBatch(
  repo: string,
  branch: string,
  slugs: string[],
): Promise<Map<string, GitHubMeta>> {
  const cache: CacheData = {}
  const results = new Map<string, GitHubMeta>()

  // Fetch contributor history from -Contribution repo (where real edits happen)
  const contribMap = await fetchContributorsFromContribRepo(repo, slugs)

  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE)
    const historyFields = batch.map(slug => {
      const alias = slugToAlias(slug)
      const path = `tutorials/${slug}/${slug}.md`
      return `${alias}: history(first: 30, path: "${path}") {
        nodes {
          oid
          authoredDate
          author {
            name
            email
            user { login avatarUrl }
          }
        }
      }`
    }).join('\n            ')

    const query = `{
      repository(owner: "${ORG}", name: "${repo}") {
        defaultBranchRef {
          target {
            ... on Commit {
              ${historyFields}
            }
          }
        }
      }
    }`

    try {
      const data = await graphqlRequest(query)
      const commit = data.repository?.defaultBranchRef?.target
      if (!commit) continue

      for (const [alias, historyData] of Object.entries(commit) as Array<[string, any]>) {
        if (alias === '__typename') continue
        const slug = aliasToSlug(alias, batch)
        if (!slug) continue

        const nodes = historyData?.nodes ?? []
        if (nodes.length === 0) {
          results.set(slug, fallback())
          continue
        }

        const lastCommitSha = nodes[0].oid ?? ''
        const lastUpdated = nodes[0].authoredDate ?? ''
        const createdAt = nodes[nodes.length - 1].authoredDate ?? ''

        // Prefer contributors from -Contribution repo; fall back to main repo
        const contributors = contribMap.get(slug) ?? extractContributors(nodes)

        const meta: GitHubMeta = { lastCommitSha, lastUpdated, createdAt, contributors }
        results.set(slug, meta)
        cache[slug] = meta
      }
    } catch (err) {
      console.warn(`  [warn] GraphQL batch failed for ${repo} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : err}; trying REST per-slug...`)
      for (const slug of batch) {
        if (results.has(slug)) continue
        const restMeta = await fetchMetaFromRest(repo, slug, branch)
        if (restMeta) {
          // Prefer contributors from -Contribution repo (GraphQL or REST), then commit-based
          const restContrib = contribMap.get(slug) ?? await fetchContributorsFromRestContrib(repo, slug, branch)
          const meta: GitHubMeta = { ...restMeta, contributors: restContrib ?? restMeta.contributors }
          results.set(slug, meta)
          cache[slug] = meta
        } else {
          results.set(slug, fallback())
        }
      }
    }
  }

  const existingCache = loadCache()
  Object.assign(existingCache, cache)
  saveCache(existingCache)
  return results
}

export async function fetchGitHubMeta(slug: string, repo: string, branch: string): Promise<GitHubMeta> {
  const cache = loadCache()
  if (cache[slug]) return cache[slug]

  const batchResult = await fetchGitHubMetaBatch(repo, branch, [slug])
  return batchResult.get(slug) ?? fallback()
}

function fallback(): GitHubMeta {
  return { lastCommitSha: '', lastUpdated: '', createdAt: '', contributors: [] }
}

export async function fetchRulesVr(slug: string, repo: string, branch: string): Promise<string | null> {
  const cacheFile = join(dirname(CACHE_FILE), `${slug}.rules.vr`)
  if (existsSync(cacheFile)) {
    return readFileSync(cacheFile, 'utf-8')
  }

  const contribRepo = repo.endsWith('-Contribution') ? repo : `${repo}-Contribution`
  const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
  if (!token) return null

  const url = `https://raw.githubusercontent.com/${ORG}/${contribRepo}/${branch}/tutorials/${slug}/rules.vr`
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'tutorials-poc-build' },
    })
    if (!res.ok) return null
    const content = await res.text()
    mkdirSync(dirname(cacheFile), { recursive: true })
    writeFileSync(cacheFile, content, 'utf-8')
    return content
  } catch {
    return null
  }
}
