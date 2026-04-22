import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '..', '..', '.tutorial-cache', 'github-meta.json')

export interface GitHubContributor {
  name: string
  login: string
  avatarUrl: string
}

export interface GitHubMeta {
  lastUpdated: string
  createdAt: string
  contributors: GitHubContributor[]
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

export async function fetchGitHubMeta(slug: string, repo: string): Promise<GitHubMeta> {
  const cache = loadCache()
  if (cache[slug]) {
    console.log(`  [cache] github-meta for ${slug}`)
    return cache[slug]
  }

  const branch = repo === 'Tutorials' ? 'master' : 'main'
  const path = `tutorials/${slug}/${slug}.md`
  const url = `https://api.github.com/repos/sap-tutorials/${repo}/commits?path=${path}&sha=${branch}&per_page=100`

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'tutorials-poc-build',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  console.log(`  [fetch] github commits for ${slug}`)

  try {
    const res = await fetch(url, { headers })
    if (!res.ok) {
      console.warn(`  [warn] GitHub API ${res.status} for ${slug}, using fallback`)
      return fallback()
    }

    const commits: Array<{
      commit: {
        author: { name: string; date: string }
      }
      author?: { login: string; avatar_url: string } | null
    }> = await res.json()

    if (commits.length === 0) return fallback()

    const lastUpdated = commits[0].commit.author.date
    const createdAt = commits[commits.length - 1].commit.author.date

    const seen = new Set<string>()
    const contributors: GitHubContributor[] = []
    for (const c of commits) {
      const login = c.author?.login ?? ''
      if (!login || seen.has(login)) continue
      seen.add(login)
      contributors.push({
        name: c.commit.author.name,
        login,
        avatarUrl: c.author?.avatar_url ?? '',
      })
    }

    const meta: GitHubMeta = { lastUpdated, createdAt, contributors }
    cache[slug] = meta
    saveCache(cache)
    return meta
  } catch (err) {
    console.warn(`  [warn] GitHub fetch failed for ${slug}:`, err)
    return fallback()
  }
}

function fallback(): GitHubMeta {
  return { lastUpdated: '', createdAt: '', contributors: [] }
}
