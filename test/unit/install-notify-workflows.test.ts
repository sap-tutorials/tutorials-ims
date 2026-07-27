// test/unit/install-notify-workflows.test.ts
//
// Tests for the unified notify-workflow installer (#1154). Pure logic
// (classification + action decision) is unit-tested directly; the GitHub
// REST calls are exercised via fetch mocks.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  classifyRepos,
  decideAction,
  encodeContent,
  installOne,
  installViaPr,
  isPullRequestRequired,
  listOrgRepos,
  EXCLUDED_REPOS,
  INCLUDED_PRIVATE_REPOS,
} from '../../scripts/install-notify-workflows.ts'

describe('classifyRepos', () => {
  it('splits source vs -Contribution repos and drops excluded/archived/fork', () => {
    const repos = [
      { name: 'cap-getting-started', isArchived: false, isFork: false, isDisabled: false },
      { name: 'abap-core-Contribution', isArchived: false, isFork: false, isDisabled: false },
      { name: 'tutorials-ims', isArchived: false, isFork: false, isDisabled: false },   // excluded
      { name: 'sandbox', isArchived: false, isFork: false, isDisabled: false },          // excluded
      { name: 'old-thing', isArchived: true, isFork: false, isDisabled: false },         // archived
      { name: 'a-fork', isArchived: false, isFork: true, isDisabled: false },            // fork
    ]
    const { sourceRepos, contributionRepos } = classifyRepos(repos)
    expect(sourceRepos).toEqual(['cap-getting-started'])
    expect(contributionRepos).toEqual(['abap-core-Contribution'])
  })

  it('excludes non-content org repos that pass the name heuristic (.github, tutorial-actions)', () => {
    const { sourceRepos } = classifyRepos([
      { name: '.github', isArchived: false, isFork: false, isDisabled: false },
      { name: 'tutorial-actions', isArchived: false, isFork: false, isDisabled: false },
      { name: 'abap-core-development', isArchived: false, isFork: false, isDisabled: false },
    ])
    expect(sourceRepos).toEqual(['abap-core-development'])   // the two non-content repos dropped
    expect(EXCLUDED_REPOS.has('.github')).toBe(true)
    expect(EXCLUDED_REPOS.has('tutorial-actions')).toBe(true)
  })

  it('excludes sandbox-Contribution (test fixture, not real)', () => {
    const { contributionRepos } = classifyRepos([
      { name: 'sandbox-Contribution', isArchived: false, isFork: false, isDisabled: false },
      { name: 'real-Contribution', isArchived: false, isFork: false, isDisabled: false },
    ])
    expect(contributionRepos).toEqual(['real-Contribution'])
    expect(EXCLUDED_REPOS.has('sandbox-Contribution')).toBe(true)
  })

  it('skips private non-Contribution repos unless allowlisted (mirrors build discovery)', () => {
    const { sourceRepos, contributionRepos } = classifyRepos([
      { name: 'secret-internal', isArchived: false, isFork: false, isDisabled: false, isPrivate: true },   // dropped
      { name: 'meta-tutorials', isArchived: false, isFork: false, isDisabled: false, isPrivate: true },     // allowlisted → source
      { name: 'private-Contribution', isArchived: false, isFork: false, isDisabled: false, isPrivate: true },// -Contribution re-admitted
      { name: 'public-source', isArchived: false, isFork: false, isDisabled: false, isPrivate: false },
    ])
    expect(sourceRepos.sort()).toEqual(['meta-tutorials', 'public-source'])
    expect(contributionRepos).toEqual(['private-Contribution'])
    expect(INCLUDED_PRIVATE_REPOS.has('meta-tutorials')).toBe(true)
  })
})

describe('listOrgRepos pagination', () => {
  it('follows hasNextPage/endCursor across pages and concatenates nodes', async () => {
    const pages = [
      { nodes: [{ name: 'a', isArchived: false, isFork: false, isDisabled: false, isPrivate: false }], pageInfo: { hasNextPage: true, endCursor: 'CUR1' } },
      { nodes: [{ name: 'b', isArchived: false, isFork: false, isDisabled: false, isPrivate: false }], pageInfo: { hasNextPage: false, endCursor: null } },
    ]
    let call = 0
    const seenCursors: (string | null)[] = []
    global.fetch = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body)
      seenCursors.push(/after: "([^"]+)"/.exec(body.query)?.[1] ?? null)
      const page = pages[call++]
      return { ok: true, status: 200, json: async () => ({ data: { organization: { repositories: page } } }) } as any
    }) as any
    const repos = await listOrgRepos('t0k')
    expect(repos.map((r) => r.name)).toEqual(['a', 'b'])
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(seenCursors).toEqual([null, 'CUR1'])   // page 2 used page 1's endCursor
  })
})

describe('decideAction', () => {
  const rendered = 'name: X\non: push\n'
  it('installs when the file is absent', () => {
    expect(decideAction(null, rendered)).toBe('install')
  })
  it('skips when existing content is byte-identical', () => {
    expect(decideAction(rendered, rendered)).toBe('skip')
  })
  it('skips when existing differs only by trailing whitespace/newlines', () => {
    expect(decideAction(rendered + '\n\n', rendered)).toBe('skip')
  })
  it('updates when existing content differs materially', () => {
    expect(decideAction('name: OLD\non: push\n', rendered)).toBe('update')
  })
})

describe('installOne (fetch-mocked, idempotent)', () => {
  const token = 't0k'
  const repo = 'cap-getting-started'
  const path = '.github/workflows/notify-tutorials-ims.yml'
  const content = 'name: Notify\non: {push: {branches: [main]}}\n'

  beforeEach(() => { vi.restoreAllMocks() })

  it('skips (no write) when the workflow already matches', async () => {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/contents/')) {
        return { ok: true, status: 200, json: async () => ({ content: b64, sha: 'abc' }) } as any
      }
      throw new Error('unexpected write in skip path: ' + url)
    })
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: true })
    expect(res.action).toBe('skip')
    // Only the GET happened — no PUT.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('installs (PUT with no sha) when absent', async () => {
    let putBody: any = null
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (init?.method === 'PUT') { putBody = JSON.parse(init.body); return { ok: true, status: 201, json: async () => ({}) } as any }
      return { ok: false, status: 404, json: async () => ({}) } as any   // GET → absent
    })
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: true })
    expect(res.action).toBe('install')
    expect(putBody.sha).toBeUndefined()                       // create, not update
    expect(Buffer.from(putBody.content, 'base64').toString('utf8')).toBe(content)
    expect(putBody.branch).toBe('main')
  })

  it('updates (PUT WITH sha) when content drifted', async () => {
    let putBody: any = null
    const oldB64 = Buffer.from('name: OLD\n', 'utf8').toString('base64')
    const fetchMock = vi.fn(async (url: string, init: any) => {
      if (init?.method === 'PUT') { putBody = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) } as any }
      return { ok: true, status: 200, json: async () => ({ content: oldB64, sha: 'oldsha' }) } as any
    })
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: true })
    expect(res.action).toBe('update')
    expect(putBody.sha).toBe('oldsha')                        // update requires prior sha
  })

  it('dry-run never writes even when action would be install', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }) as any)
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: false })
    expect(res.action).toBe('install')                        // decision reported
    expect(res.wouldWrite).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)                // GET only, no PUT
  })
})

describe('isPullRequestRequired', () => {
  const msg = '{"message":"Repository rule violations found","documentation_url":"...","status":"409"}\nChanges must be made through a pull request.'
  it('detects the 409 PR-required rule violation', () => {
    expect(isPullRequestRequired(409, msg)).toBe(true)
    expect(isPullRequestRequired(409, 'must be made through a pull request')).toBe(true)
  })
  it('does NOT treat an unrelated 409 as PR-required (e.g. stale sha conflict)', () => {
    expect(isPullRequestRequired(409, 'is at 0abc but expected 1def')).toBe(false)
  })
  it('does NOT treat non-409 statuses as PR-required', () => {
    expect(isPullRequestRequired(422, 'must be made through a pull request')).toBe(false)
    expect(isPullRequestRequired(404, 'not found')).toBe(false)
  })
})

describe('installOne PR fallback on 409 (branch-protected repo, #1333)', () => {
  const token = 't0k'
  const repo = 'abap-core-development'
  const path = '.github/workflows/notify-tutorials-ims.yml'
  const content = 'name: Notify\non: {push: {branches: [main]}}\n'
  const PR_REQUIRED = 'Repository rule violations found\nChanges must be made through a pull request.'

  beforeEach(() => { vi.restoreAllMocks() })

  /** Route a GitHub REST call by URL + method through the supplied handlers. */
  function routeFetch(handlers: {
    getContents?: (url: string) => any        // direct GET (no ?ref)
    putDefault?: (body: any) => any           // PUT branch=main → 409
    getRef?: () => any                        // GET /git/ref/heads/main
    postRef?: (body: any) => any              // POST /git/refs (create branch)
    getBranchContents?: (url: string) => any  // GET ?ref=feature
    putBranch?: (body: any) => any            // PUT branch=feature
    postPull?: (body: any) => any             // POST /pulls
    listPulls?: () => any                     // GET /pulls?head=...
  }) {
    return vi.fn(async (url: string, init: any) => {
      const method = init?.method ?? 'GET'
      if (method === 'PUT') {
        const body = JSON.parse(init.body)
        if (body.branch && body.branch !== 'main') return handlers.putBranch!(body)
        return handlers.putDefault!(body)
      }
      if (method === 'POST' && url.endsWith('/git/refs')) return handlers.postRef!(JSON.parse(init.body))
      if (method === 'POST' && url.includes('/pulls')) return handlers.postPull!(JSON.parse(init.body))
      if (url.includes('/git/ref/heads/')) return handlers.getRef!()
      if (url.includes('/pulls?')) return handlers.listPulls!()
      if (url.includes('?ref=')) return handlers.getBranchContents!(url)
      if (url.includes('/contents/')) return handlers.getContents!(url)
      throw new Error(`unrouted fetch: ${method} ${url}`)
    })
  }

  it('opens a PR when the direct commit 409s (file absent, fresh branch)', async () => {
    let branchPut: any = null
    const fetchMock = routeFetch({
      getContents: () => ({ ok: false, status: 404, json: async () => ({}) }),        // absent → install
      putDefault: () => ({ ok: false, status: 409, text: async () => PR_REQUIRED }),   // protected
      getRef: () => ({ ok: true, status: 200, json: async () => ({ object: { sha: 'basesha' } }) }),
      postRef: () => ({ ok: true, status: 201, json: async () => ({}) }),              // branch created
      getBranchContents: () => ({ ok: false, status: 404, json: async () => ({}) }),   // absent on branch
      putBranch: (b) => { branchPut = b; return { ok: true, status: 201, json: async () => ({}) } },
      postPull: () => ({ ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/sap-tutorials/abap-core-development/pull/2722' }) }),
    })
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: true })
    expect(res.action).toBe('pr-opened')
    expect(res.prUrl).toBe('https://github.com/sap-tutorials/abap-core-development/pull/2722')
    expect(branchPut.branch).toBe('chore/1154-notify-workflow-refresh')
    expect(Buffer.from(branchPut.content, 'base64').toString('utf8')).toBe(content)
    expect(branchPut.sha).toBeUndefined()   // create on branch (was absent)
  })

  it('reuses an existing branch (422) and is idempotent when branch content is already current → pr-updated', async () => {
    const b64 = Buffer.from(content, 'utf8').toString('base64')
    let branchPutCalled = false
    const fetchMock = routeFetch({
      getContents: () => ({ ok: true, status: 200, json: async () => ({ content: Buffer.from('name: OLD\n', 'utf8').toString('base64'), sha: 'oldsha' }) }), // drift → update
      putDefault: () => ({ ok: false, status: 409, text: async () => PR_REQUIRED }),
      getRef: () => ({ ok: true, status: 200, json: async () => ({ object: { sha: 'basesha' } }) }),
      postRef: () => ({ ok: false, status: 422, text: async () => 'Reference already exists' }), // reuse
      getBranchContents: () => ({ ok: true, status: 200, json: async () => ({ content: b64, sha: 'branchsha' }) }), // already current
      putBranch: () => { branchPutCalled = true; return { ok: true, status: 200, json: async () => ({}) } },
      postPull: () => ({ ok: false, status: 422, text: async () => 'A pull request already exists' }),
      listPulls: () => ({ ok: true, status: 200, json: async () => ([{ html_url: 'https://github.com/sap-tutorials/abap-core-development/pull/999' }]) }),
    })
    global.fetch = fetchMock as any
    const res = await installOne({ repo, path, content, token, defaultBranch: 'main', execute: true })
    expect(res.action).toBe('pr-updated')
    expect(res.prUrl).toBe('https://github.com/sap-tutorials/abap-core-development/pull/999')
    expect(branchPutCalled).toBe(false)   // branch content already matches → no PUT
  })

  it('still throws (not PR fallback) on an unrelated PUT error', async () => {
    const fetchMock = vi.fn(async (_url: string, init: any) => {
      if (init?.method === 'PUT') return { ok: false, status: 403, text: async () => 'forbidden' } as any
      return { ok: false, status: 404, json: async () => ({}) } as any
    })
    global.fetch = fetchMock as any
    await expect(installOne({ repo, path, content, token, defaultBranch: 'main', execute: true }))
      .rejects.toThrow(/403/)
  })
})

describe('installViaPr (direct, fetch-mocked)', () => {
  const token = 't0k'
  const repo = 'btp-foundation'
  const path = '.github/workflows/notify-tutorials-ims.yml'
  const content = 'name: Notify\n'

  beforeEach(() => { vi.restoreAllMocks() })

  it('PUTs to the feature branch with the prior sha when the branch file drifted', async () => {
    let branchPut: any = null
    global.fetch = vi.fn(async (url: string, init: any) => {
      const method = init?.method ?? 'GET'
      if (method === 'PUT') { branchPut = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({}) } as any }
      if (method === 'POST' && url.endsWith('/git/refs')) return { ok: true, status: 201, json: async () => ({}) } as any
      if (method === 'POST' && url.includes('/pulls')) return { ok: true, status: 201, json: async () => ({ html_url: 'https://x/pull/1' }) } as any
      if (url.includes('/git/ref/heads/')) return { ok: true, status: 200, json: async () => ({ object: { sha: 'base' } }) } as any
      if (url.includes('?ref=')) return { ok: true, status: 200, json: async () => ({ content: Buffer.from('name: OLD\n', 'utf8').toString('base64'), sha: 'bsha' }) } as any
      throw new Error(`unrouted: ${method} ${url}`)
    }) as any
    const res = await installViaPr({ repo, path, content, token, defaultBranch: 'main' })
    expect(res.action).toBe('pr-opened')
    expect(branchPut.sha).toBe('bsha')   // overwrite on branch requires prior sha
    expect(branchPut.branch).toBe('chore/1154-notify-workflow-refresh')
  })
})

describe('encodeContent', () => {
  it('base64-encodes UTF-8 content', () => {
    expect(Buffer.from(encodeContent('héllo'), 'base64').toString('utf8')).toBe('héllo')
  })
})
