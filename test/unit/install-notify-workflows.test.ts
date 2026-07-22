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

describe('encodeContent', () => {
  it('base64-encodes UTF-8 content', () => {
    expect(Buffer.from(encodeContent('héllo'), 'base64').toString('utf8')).toBe('héllo')
  })
})
