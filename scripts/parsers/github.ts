import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', '.tutorial-cache')
const CACHE_FILE = join(CACHE_DIR, 'github-meta.json')
const DISCOVERY_CACHE_FILE = join(CACHE_DIR, '_discovery.json')
const ORG = 'sap-tutorials'
const GRAPHQL_URL = 'https://api.github.com/graphql'
const BATCH_SIZE = 20

// Retry policy: 8 attempts, exponential backoff with jitter, capped at 60s.
// GitHub incidents are typically <30 min, so total max wait of ~5 min covers most.
const MAX_RETRIES = 8
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

export const EXCLUDED_REPOS = new Set(['tutorials-ims', 'meta-tutorials'])

export interface GitHubContributor {
  name: string
  login: string
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

async function graphqlRequest(query: string, retries = MAX_RETRIES): Promise<any> {
  const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN is required for GraphQL API')

  let lastError: Error | null = null

  for (let attempt = 1; attempt <= retries; attempt++) {
    let res: Response
    try {
      res = await fetch(GRAPHQL_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'tutorials-poc-build',
        },
        body: JSON.stringify({ query }),
      })
    } catch (err) {
      // Network failure (DNS, connection refused, TLS, etc.) — retry.
      lastError = err instanceof Error ? err : new Error(String(err))
      if (attempt < retries) {
        const wait = backoffDelay(attempt)
        console.warn(`  [graphql] network error on attempt ${attempt}/${retries}: ${lastError.message}; retrying in ${Math.round(wait / 1000)}s...`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      break
    }

    const retryable = res.status >= 500 || res.status === 429
    if (retryable && attempt < retries) {
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
      const wait = retryAfter ?? backoffDelay(attempt)
      console.warn(`  [graphql] ${res.status} on attempt ${attempt}/${retries}, retrying in ${Math.round(wait / 1000)}s...`)
      await new Promise(r => setTimeout(r, wait))
      continue
    }

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

  throw new Error(`GraphQL request failed after ${retries} attempts${lastError ? `: ${lastError.message}` : ''}`)
}

function loadDiscoveryCache(): DiscoveredTutorial[] | null {
  if (!existsSync(DISCOVERY_CACHE_FILE)) return null
  try {
    const map = JSON.parse(readFileSync(DISCOVERY_CACHE_FILE, 'utf-8')) as Record<string, DiscoveredTutorial>
    const tutorials = Object.values(map).filter(
      (t): t is DiscoveredTutorial =>
        !!t && typeof t.slug === 'string' && typeof t.repo === 'string' && typeof t.branch === 'string',
    )
    return tutorials.length > 0 ? tutorials : null
  } catch {
    return null
  }
}

export async function discoverAllTutorials(): Promise<DiscoveredTutorial[]> {
  try {
    return await discoverFromGitHub()
  } catch (err) {
    const cached = loadDiscoveryCache()
    if (cached) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`\n  [graphql] Discovery failed (${message})`)
      console.warn(`  [graphql] Falling back to cached discovery map (${cached.length} tutorials, ${DISCOVERY_CACHE_FILE})`)
      console.warn(`  [graphql] Cache may be stale — re-run later when GitHub recovers to refresh.\n`)
      return cached
    }
    throw err
  }
}

async function discoverFromGitHub(): Promise<DiscoveredTutorial[]> {
  const includeContribution = process.env.INCLUDE_CONTRIBUTION_REPOS === 'true'
  const tutorials: DiscoveredTutorial[] = []
  let cursor: string | null = null
  let page = 0

  while (true) {
    page++
    const afterClause = cursor ? `, after: "${cursor}"` : ''
    const query = `{
      organization(login: "${ORG}") {
        repositories(first: 100${afterClause}, orderBy: {field: NAME, direction: ASC}) {
          nodes {
            name
            isArchived
            isDisabled
            isFork
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
    }`

    console.log(`  [graphql] Discovering repos (page ${page})...`)
    const data = await graphqlRequest(query)
    const repos = data.organization.repositories

    for (const repo of repos.nodes) {
      if (repo.isArchived || repo.isDisabled || repo.isFork) continue
      if (EXCLUDED_REPOS.has(repo.name)) continue
      if (!includeContribution && repo.name.endsWith('-Contribution')) continue
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

function extractContributors(nodes: any[]): GitHubContributor[] {
  const seen = new Set<string>()
  const contributors: GitHubContributor[] = []
  for (const node of nodes) {
    const login = node.author?.user?.login ?? ''
    if (!login || seen.has(login)) continue
    seen.add(login)
    contributors.push({
      name: node.author?.name ?? login,
      login,
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
      console.warn(`  [warn] GraphQL batch failed for ${repo} batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err instanceof Error ? err.message : err}`)
      for (const slug of batch) {
        if (!results.has(slug)) results.set(slug, fallback())
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
