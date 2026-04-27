import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '..', '..', '.tutorial-cache', 'github-meta.json')
const ORG = 'sap-tutorials'
const GRAPHQL_URL = 'https://api.github.com/graphql'
const BATCH_SIZE = 20

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

async function graphqlRequest(query: string): Promise<any> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN is required for GraphQL API')

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'tutorials-poc-build',
    },
    body: JSON.stringify({ query }),
  })

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

export async function discoverAllTutorials(): Promise<DiscoveredTutorial[]> {
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

export async function fetchGitHubMetaBatch(
  repo: string,
  branch: string,
  slugs: string[],
): Promise<Map<string, GitHubMeta>> {
  const cache: CacheData = {}
  const results = new Map<string, GitHubMeta>()

  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE)
    const historyFields = batch.map(slug => {
      const alias = slugToAlias(slug)
      const path = `tutorials/${slug}/${slug}.md`
      return `${alias}: history(first: 10, path: "${path}") {
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
