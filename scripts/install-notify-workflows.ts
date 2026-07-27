// scripts/install-notify-workflows.ts
//
// Unified, idempotent installer for the two "notify tutorials-ims" workflows
// that fire repository_dispatch into the content pipeline (#1154):
//
//   1. PROD content flow  — `notify-tutorials-ims.yml` (fires `tutorial-updated`
//      → rebuild-content.yml). Installed into every tutorial *source* repo.
//      Template: docs/authors/tutorial-repo-dispatch.yml
//   2. QA preview flow    — `notify-qa.yml` (fires `tutorial-qa-updated`
//      → rebuild-content-qa.yml). Installed into every `*-Contribution` repo.
//      Template: .github/workflows/notify-qa.yml.template
//
// Design (see docs/developers/operations/notify-workflow-install.md):
//   - Discovery is LIVE via the GitHub GraphQL org listing, so repos created
//     after the last run are picked up automatically — just re-run.
//   - IDEMPOTENT: for each repo it GETs the existing workflow file and
//     content-compares (whitespace-normalized) against the rendered template.
//       absent          → install (create)
//       identical        → skip (no write)
//       differs          → update (PUT with prior sha)
//     Re-running when everything is current opens/commits NOTHING.
//   - Applies by committing DIRECTLY to the repo's default branch. When the
//     repo requires a PR (branch protection → 409 rule violation), it FALLS
//     BACK to opening/updating a PR from a shared feature branch and reports
//     that as pr-opened / pr-updated instead of erroring (#1333).
//   - Safe by default: --dry-run (the DEFAULT) only reports the decision per
//     repo; pass --execute to actually commit.
//
// Auth: GITHUB_TOKEN / TUTORIALS_GITHUB_TOKEN with Contents:write on the
// target repos (native fetch — no octokit, per project convention).
//
// Usage:
//   tsx scripts/install-notify-workflows.ts                 # dry-run, both sets
//   tsx scripts/install-notify-workflows.ts --execute       # commit changes
//   tsx scripts/install-notify-workflows.ts --only qa        # only QA template
//   tsx scripts/install-notify-workflows.ts --only prod      # only PROD template

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const ORG = 'sap-tutorials'
const GRAPHQL_URL = 'https://api.github.com/graphql'
const REST_API_BASE = 'https://api.github.com'

// Mirror scripts/parsers/github.ts EXCLUDED_REPOS: tutorials-ims is the
// platform itself; sandbox / sandbox-Contribution are Sage/BAS test fixtures.
// Plus non-content org repos that pass the name heuristic but hold NO
// tutorials/ tree (verified 2026-07-22): `.github` is the org profile repo and
// `tutorial-actions` is shared GitHub Actions — a push to either must NOT fire
// a prod content rebuild. (The build's own discovery filters by presence of a
// tutorials/ tree; this installer classifies by name, so these two need
// explicit exclusion until the installer gains the same tree check.)
export const EXCLUDED_REPOS = new Set([
  'tutorials-ims', 'sandbox', 'sandbox-Contribution',
  '.github', 'tutorial-actions',
])

// Mirror scripts/parsers/github.ts INCLUDED_PRIVATE_REPOS: private repos are
// skipped by default (org-private repos aren't tutorial sources), EXCEPT these
// explicit allowlist entries and any *-Contribution repo (handled by suffix).
// Keeping this in sync with the build's discovery is why classifyRepos claims
// "same classification the build uses".
export const INCLUDED_PRIVATE_REPOS = new Set(['meta-tutorials'])

const PROD_WORKFLOW_PATH = '.github/workflows/notify-tutorials-ims.yml'
const QA_WORKFLOW_PATH = '.github/workflows/notify-qa.yml'

// Feature branch used by the PR-on-409 fallback (branch-protected repos that
// reject a direct commit to the default branch — see #1333). Reused across
// runs so re-running against a still-stale protected repo updates the same PR
// rather than opening a new one each time.
const FEATURE_BRANCH = 'chore/1154-notify-workflow-refresh'

export type RepoNode = {
  name: string
  isArchived: boolean
  isFork: boolean
  isDisabled: boolean
  isPrivate?: boolean
}

/**
 * Split a raw org repo list into source repos (get the PROD template) and
 * `*-Contribution` repos (get the QA template), dropping excluded / archived
 * / disabled / fork repos. Private non-Contribution repos are skipped unless
 * allowlisted in INCLUDED_PRIVATE_REPOS — matching the build's discovery
 * (scripts/parsers/github.ts) exactly.
 */
export function classifyRepos(repos: RepoNode[]): {
  sourceRepos: string[]
  contributionRepos: string[]
} {
  const sourceRepos: string[] = []
  const contributionRepos: string[] = []
  for (const r of repos) {
    if (r.isArchived || r.isDisabled || r.isFork) continue
    if (EXCLUDED_REPOS.has(r.name)) continue
    // Private repos: include only if allowlisted OR a -Contribution repo
    // (the suffix branch below re-admits those). Mirrors github.ts:563.
    if (r.isPrivate && !INCLUDED_PRIVATE_REPOS.has(r.name) && !r.name.endsWith('-Contribution')) continue
    if (EXCLUDED_REPOS.has(r.name)) continue
    if (r.name.endsWith('-Contribution')) contributionRepos.push(r.name)
    else sourceRepos.push(r.name)
  }
  return { sourceRepos, contributionRepos }
}

/** Decide what to do given the existing file content (or null) vs the target.
 *  Trailing-whitespace-insensitive so a stored file that only differs by a
 *  final newline is treated as identical (no churn). */
export function decideAction(existing: string | null, rendered: string): 'install' | 'skip' | 'update' {
  if (existing == null) return 'install'
  if (existing.replace(/\s+$/, '') === rendered.replace(/\s+$/, '')) return 'skip'
  return 'update'
}

export function encodeContent(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64')
}

function authHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tutorials-ims-notify-installer',
    ...extra,
  }
}

/** GET the current workflow file (optionally on a specific branch `ref`).
 *  Returns { content, sha } or null on 404. */
async function getExistingFile(
  repo: string, path: string, token: string, ref?: string,
): Promise<{ content: string; sha: string } | null> {
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : ''
  const url = `${REST_API_BASE}/repos/${ORG}/${repo}/contents/${path}${q}`
  const res = await fetch(url, { headers: authHeaders(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ${repo}/${path}: ${res.status}`)
  const json: any = await res.json()
  return { content: Buffer.from(json.content ?? '', 'base64').toString('utf8'), sha: json.sha }
}

export type Action = 'install' | 'skip' | 'update' | 'pr-opened' | 'pr-updated'

/**
 * True when a Contents-API PUT was rejected because the repo's branch
 * protection / rulesets require changes to land through a pull request. GitHub
 * returns 409 with a message like "Repository rule violations found — Changes
 * must be made through a pull request." (#1333). Detected on status + message
 * so we don't misclassify an unrelated 409 (e.g. a stale-sha conflict).
 */
export function isPullRequestRequired(status: number, detail: string): boolean {
  if (status !== 409) return false
  return /must be made through a pull request/i.test(detail)
}

/** SHA of a branch head, or null if the branch does not exist (404). */
async function getRefSha(repo: string, branch: string, token: string): Promise<string | null> {
  const url = `${REST_API_BASE}/repos/${ORG}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`
  const res = await fetch(url, { headers: authHeaders(token) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET ref ${repo}/${branch}: ${res.status}`)
  const json: any = await res.json()
  return json.object?.sha ?? null
}

/** Create the feature branch at `fromSha`, treating 422 (already exists) as reuse. */
async function ensureBranch(repo: string, branch: string, fromSha: string, token: string): Promise<void> {
  const res = await fetch(`${REST_API_BASE}/repos/${ORG}/${repo}/git/refs`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
  })
  if (res.status === 422) return   // branch already exists → reuse
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`create branch ${repo}/${branch}: ${res.status} ${detail.slice(0, 200)}`)
  }
}

/**
 * Open a PR from `head` into `base`. Returns { url, created }. When the PR is
 * already open GitHub returns 422; we treat that as success and look up the
 * existing PR's URL so the caller can surface it (created=false → pr-updated).
 */
async function openPullRequest(opts: {
  repo: string; head: string; base: string; title: string; body: string; token: string
}): Promise<{ url: string; created: boolean }> {
  const { repo, head, base, title, body, token } = opts
  const res = await fetch(`${REST_API_BASE}/repos/${ORG}/${repo}/pulls`, {
    method: 'POST',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ title, head, base, body }),
  })
  if (res.ok) {
    const json: any = await res.json()
    return { url: json.html_url ?? '', created: true }
  }
  if (res.status === 422) {
    // A PR from this branch is already open — surface its URL.
    const q = `head=${encodeURIComponent(`${ORG}:${head}`)}&base=${encodeURIComponent(base)}&state=open`
    const list = await fetch(`${REST_API_BASE}/repos/${ORG}/${repo}/pulls?${q}`, { headers: authHeaders(token) })
    const arr: any = list.ok ? await list.json() : []
    return { url: Array.isArray(arr) && arr[0]?.html_url ? arr[0].html_url : '', created: false }
  }
  const detail = await res.text().catch(() => '')
  throw new Error(`open PR ${repo} ${head}->${base}: ${res.status} ${detail.slice(0, 200)}`)
}

/**
 * PR-mode apply for branch-protected repos (#1333). Renders steps 1–5:
 * resolve default-branch head → ensure feature branch → compare branch content
 * (skip PUT if already current) → PUT to the branch → open/reuse the PR.
 * Returns pr-opened (new PR) or pr-updated (PR already open) with its URL.
 */
export async function installViaPr(opts: {
  repo: string; path: string; content: string; token: string; defaultBranch: string
}): Promise<{ repo: string; action: 'pr-opened' | 'pr-updated'; wouldWrite: boolean; prUrl: string }> {
  const { repo, path, content, token, defaultBranch } = opts

  // 1. default-branch head sha (base for the feature branch).
  const baseSha = await getRefSha(repo, defaultBranch, token)
  if (!baseSha) throw new Error(`PR fallback ${repo}: default branch ${defaultBranch} has no head sha`)

  // 2. create/reuse the feature branch.
  await ensureBranch(repo, FEATURE_BRANCH, baseSha, token)

  // 3. current file on the branch — skip the PUT when already current.
  const onBranch = await getExistingFile(repo, path, token, FEATURE_BRANCH)
  if (decideAction(onBranch?.content ?? null, content) !== 'skip') {
    // 4. PUT the rendered template to the feature branch.
    const body: Record<string, unknown> = {
      message: `chore(#1154): refresh notify workflow (${path})`,
      content: encodeContent(content),
      branch: FEATURE_BRANCH,
    }
    if (onBranch) body.sha = onBranch.sha
    const put = await fetch(`${REST_API_BASE}/repos/${ORG}/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
    })
    if (!put.ok) {
      const detail = await put.text().catch(() => '')
      throw new Error(`PUT (PR branch) ${repo}/${path}: ${put.status} ${detail.slice(0, 200)}`)
    }
  }

  // 5. open (or reuse) the PR against the default branch.
  const { url, created } = await openPullRequest({
    repo, head: FEATURE_BRANCH, base: defaultBranch, token,
    title: `chore(#1154): refresh notify workflow (${path.split('/').pop()})`,
    body: `Automated by \`install-notify-workflows.ts\` — this repo requires changes via PR, so the notify workflow (\`${path}\`) is delivered here instead of a direct commit. See sap-tutorials/tutorials-ims#1333.`,
  })
  return { repo, action: created ? 'pr-opened' : 'pr-updated', wouldWrite: true, prUrl: url }
}

/**
 * Idempotently install/update one workflow file in one repo. GETs first,
 * decides, and (only when execute=true and action != skip) commits directly
 * to the default branch via the Contents API. When that direct commit is
 * rejected because the repo requires a pull request (409 rule violation,
 * #1333), it falls back to PR mode (installViaPr) and reports pr-opened /
 * pr-updated instead of erroring.
 */
export async function installOne(opts: {
  repo: string
  path: string
  content: string
  token: string
  defaultBranch: string
  execute: boolean
}): Promise<{ repo: string; action: Action; wouldWrite: boolean; prUrl?: string }> {
  const { repo, path, content, token, defaultBranch, execute } = opts
  const existing = await getExistingFile(repo, path, token)
  const action = decideAction(existing?.content ?? null, content)

  if (action === 'skip') return { repo, action, wouldWrite: false }
  if (!execute) return { repo, action, wouldWrite: true }

  const url = `${REST_API_BASE}/repos/${ORG}/${repo}/contents/${path}`
  const body: Record<string, unknown> = {
    message: `chore(#1154): ${action} notify workflow (${path})`,
    content: encodeContent(content),
    branch: defaultBranch,
  }
  if (action === 'update' && existing) body.sha = existing.sha   // required to overwrite
  const res = await fetch(url, {
    method: 'PUT',
    headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    // Branch-protected repo: the direct commit is disallowed. Deliver via PR
    // instead of failing (#1333).
    if (isPullRequestRequired(res.status, detail)) {
      return installViaPr({ repo, path, content, token, defaultBranch })
    }
    throw new Error(`PUT ${repo}/${path}: ${res.status} ${detail.slice(0, 200)}`)
  }
  return { repo, action, wouldWrite: true }
}

function renderProdTemplate(): string {
  // The source-repo template lives under docs/authors/ (it's operator-facing).
  return readFileSync(join(__dirname, '..', 'docs', 'authors', 'tutorial-repo-dispatch.yml'), 'utf8')
}

function renderQaTemplate(): string {
  return readFileSync(join(__dirname, '..', '.github', 'workflows', 'notify-qa.yml.template'), 'utf8')
}

/** Live org-repo discovery via GraphQL, paginated. */
export async function listOrgRepos(token: string): Promise<RepoNode[]> {
  const out: RepoNode[] = []
  let cursor: string | null = null
  while (true) {
    const after = cursor ? `, after: "${cursor}"` : ''
    const query = `{ organization(login: "${ORG}") { repositories(first: 100${after}, orderBy: {field: NAME, direction: ASC}) {
      nodes { name isArchived isDisabled isFork isPrivate } pageInfo { endCursor hasNextPage } } } }`
    const res = await fetch(GRAPHQL_URL, {
      method: 'POST',
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ query }),
    })
    if (!res.ok) throw new Error(`GraphQL repo discovery: ${res.status}`)
    const data: any = await res.json()
    if (data.errors) throw new Error(`GraphQL errors: ${JSON.stringify(data.errors).slice(0, 200)}`)
    const page = data.data.organization.repositories
    out.push(...page.nodes)
    if (!page.pageInfo.hasNextPage) break
    cursor = page.pageInfo.endCursor
  }
  return out
}

async function getDefaultBranch(repo: string, token: string): Promise<string> {
  const res = await fetch(`${REST_API_BASE}/repos/${ORG}/${repo}`, { headers: authHeaders(token) })
  if (!res.ok) throw new Error(`GET repo ${repo}: ${res.status}`)
  const json: any = await res.json()
  return json.default_branch ?? 'main'
}

const isMainModule =
  process.argv[1] &&
  (process.argv[1].endsWith('install-notify-workflows.ts') ||
    process.argv[1].endsWith('install-notify-workflows.js'))

if (isMainModule) {
  ;(async () => {
    const execute = process.argv.includes('--execute')
    const onlyIdx = process.argv.indexOf('--only')
    const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : 'both'   // 'qa' | 'prod' | 'both'
    if (only !== 'qa' && only !== 'prod' && only !== 'both') {
      throw new Error(`--only must be one of qa|prod|both (got '${only ?? ''}')`)
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
    if (!token) throw new Error('GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN required (Contents:write on target repos)')

    console.log(`notify-workflow installer — mode=${execute ? 'EXECUTE' : 'DRY-RUN'} only=${only}`)
    const repos = await listOrgRepos(token)
    const { sourceRepos, contributionRepos } = classifyRepos(repos)
    console.log(`discovered ${sourceRepos.length} source repos, ${contributionRepos.length} -Contribution repos`)

    const jobs: Array<{ repo: string; path: string; content: string }> = []
    if (only === 'prod' || only === 'both') {
      const prod = renderProdTemplate()
      for (const r of sourceRepos) jobs.push({ repo: r, path: PROD_WORKFLOW_PATH, content: prod })
    }
    if (only === 'qa' || only === 'both') {
      const qa = renderQaTemplate()
      for (const r of contributionRepos) jobs.push({ repo: r, path: QA_WORKFLOW_PATH, content: qa })
    }

    const tally = { install: 0, update: 0, skip: 0, 'pr-opened': 0, 'pr-updated': 0, error: 0 }
    for (const j of jobs) {
      try {
        const defaultBranch = execute ? await getDefaultBranch(j.repo, token) : 'main'
        const res = await installOne({ ...j, token, defaultBranch, execute })
        tally[res.action]++
        const verb = execute ? res.action.toUpperCase() : `would-${res.action}`
        const suffix = res.prUrl ? ` (${res.prUrl})` : ''
        console.log(`  ${j.repo} ${j.path.split('/').pop()}: ${verb}${suffix}`)
      } catch (err) {
        tally.error++
        console.error(`  ${j.repo}: ERROR ${err instanceof Error ? err.message : err}`)
      }
    }
    console.log(
      `\nSummary: install=${tally.install} update=${tally.update} skip=${tally.skip} ` +
      `pr-opened=${tally['pr-opened']} pr-updated=${tally['pr-updated']} error=${tally.error}`,
    )
    if (!execute) console.log('(dry-run — re-run with --execute to commit)')
    if (tally.error > 0) process.exit(1)
  })().catch((e) => { console.error(e); process.exit(1) })
}
