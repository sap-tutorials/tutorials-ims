import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  discoverFromRest,
  fetchMetaFromRest,
  fetchContributorsFromRestContrib,
  discoverAllTutorials,
  extractContributors,
} from '../parsers/github.js'

const realFetch = global.fetch
const ORIG_TOKEN = process.env.GITHUB_TOKEN
const ORIG_TUT_TOKEN = process.env.TUTORIALS_GITHUB_TOKEN
const ORIG_INCLUDE_CONTRIB = process.env.INCLUDE_CONTRIBUTION_REPOS
const ORIG_CAP_BASE = process.env.CAP_BASE_URL

function mkResponse(
  status: number,
  body: unknown = '',
  headers: Record<string, string> = {},
): Response {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  const finalHeaders = {
    'content-type': typeof body === 'string' ? 'text/plain' : 'application/json',
    ...headers,
  }
  return new Response(payload, { status, headers: finalHeaders })
}

describe('REST API discovery + fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    process.env.GITHUB_TOKEN = 'test-token'
    delete process.env.INCLUDE_CONTRIBUTION_REPOS
    delete process.env.CAP_BASE_URL
  })

  afterEach(() => {
    vi.useRealTimers()
    global.fetch = realFetch
    vi.restoreAllMocks()
    if (ORIG_TOKEN === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = ORIG_TOKEN
    if (ORIG_TUT_TOKEN === undefined) delete process.env.TUTORIALS_GITHUB_TOKEN
    else process.env.TUTORIALS_GITHUB_TOKEN = ORIG_TUT_TOKEN
    if (ORIG_INCLUDE_CONTRIB === undefined) delete process.env.INCLUDE_CONTRIBUTION_REPOS
    else process.env.INCLUDE_CONTRIBUTION_REPOS = ORIG_INCLUDE_CONTRIB
    if (ORIG_CAP_BASE === undefined) delete process.env.CAP_BASE_URL
    else process.env.CAP_BASE_URL = ORIG_CAP_BASE
  })

  describe('discoverFromRest', () => {
    it('lists tutorials across multiple repos', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('/orgs/sap-tutorials/repos')) {
          return mkResponse(200, [
            { name: 'abap-core-development', default_branch: 'main' },
            { name: 'btp-fiori-elements', default_branch: 'main' },
            { name: 'archived-thing', archived: true, default_branch: 'main' },
            { name: 'a-fork', fork: true, default_branch: 'main' },
            { name: 'tutorials-ims', default_branch: 'main' },
            { name: 'btp-fiori-elements-Contribution', default_branch: 'main' },
          ])
        }
        if (u.includes('/repos/sap-tutorials/abap-core-development/contents/tutorials')) {
          return mkResponse(200, [
            { name: 'abap-step-1', type: 'dir' },
            { name: 'abap-step-2', type: 'dir' },
            { name: 'README.md', type: 'file' },
          ])
        }
        if (u.includes('/repos/sap-tutorials/btp-fiori-elements/contents/tutorials')) {
          return mkResponse(200, [{ name: 'fiori-step-1', type: 'dir' }])
        }
        return mkResponse(404, { message: 'Not Found' })
      })
      global.fetch = fetchMock as any

      const promise = discoverFromRest()
      await vi.runAllTimersAsync()
      const tutorials = await promise

      expect(tutorials).toEqual([
        { slug: 'abap-step-1', repo: 'abap-core-development', branch: 'main' },
        { slug: 'abap-step-2', repo: 'abap-core-development', branch: 'main' },
        { slug: 'fiori-step-1', repo: 'btp-fiori-elements', branch: 'main' },
      ])
    })

    it('paginates via Link header rel="next"', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.endsWith('/orgs/sap-tutorials/repos?per_page=100&type=public')) {
          return mkResponse(
            200,
            [{ name: 'repo-1', default_branch: 'main' }],
            {
              link: '<https://api.github.com/orgs/sap-tutorials/repos?page=2&per_page=100&type=public>; rel="next"',
            },
          )
        }
        if (u.includes('page=2')) {
          return mkResponse(200, [{ name: 'repo-2', default_branch: 'main' }])
        }
        if (u.includes('/repos/sap-tutorials/repo-1/contents/tutorials')) {
          return mkResponse(200, [{ name: 't-a', type: 'dir' }])
        }
        if (u.includes('/repos/sap-tutorials/repo-2/contents/tutorials')) {
          return mkResponse(200, [{ name: 't-b', type: 'dir' }])
        }
        return mkResponse(404)
      })
      global.fetch = fetchMock as any

      const promise = discoverFromRest()
      await vi.runAllTimersAsync()
      const tutorials = await promise

      expect(tutorials.map(t => t.slug)).toEqual(['t-a', 't-b'])
      const repoListCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/orgs/sap-tutorials/repos'))
      expect(repoListCalls).toHaveLength(2)
    })

    it('skips repos missing the tutorials directory (404)', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('/orgs/sap-tutorials/repos')) {
          return mkResponse(200, [
            { name: 'has-tutorials', default_branch: 'main' },
            { name: 'no-tutorials', default_branch: 'main' },
          ])
        }
        if (u.includes('/repos/sap-tutorials/has-tutorials/contents/tutorials')) {
          return mkResponse(200, [{ name: 'only-one', type: 'dir' }])
        }
        if (u.includes('/repos/sap-tutorials/no-tutorials/contents/tutorials')) {
          return mkResponse(404)
        }
        return mkResponse(404)
      })
      global.fetch = fetchMock as any

      const promise = discoverFromRest()
      await vi.runAllTimersAsync()
      const tutorials = await promise

      expect(tutorials).toEqual([
        { slug: 'only-one', repo: 'has-tutorials', branch: 'main' },
      ])
    })
  })

  describe('fetchMetaFromRest', () => {
    it('returns last/first commit dates and contributors deduped by login', async () => {
      const commits = [
        {
          sha: 'sha-newest',
          commit: { author: { name: 'Alice Author', date: '2026-05-21T10:00:00Z', email: 'alice@example.com' } },
          author: { login: 'alice', avatar_url: 'https://avatars.test/alice' },
        },
        {
          sha: 'sha-mid',
          commit: { author: { name: 'Bob B', date: '2026-04-01T09:00:00Z', email: 'bob@example.com' } },
          author: { login: 'bob', avatar_url: 'https://avatars.test/bob' },
        },
        {
          sha: 'sha-mid-dup',
          commit: { author: { name: 'Alice Author', date: '2026-03-15T08:00:00Z', email: 'alice@example.com' } },
          author: { login: 'alice', avatar_url: 'https://avatars.test/alice' },
        },
        {
          sha: 'sha-oldest',
          commit: { author: { name: 'Carol', date: '2025-12-01T07:00:00Z', email: '12345+carol@users.noreply.github.com' } },
          author: { login: 'carol', avatar_url: 'https://avatars.test/carol' },
        },
      ]
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, commits))
      global.fetch = fetchMock as any

      const promise = fetchMetaFromRest('abap-core-development', 'abap-step-1', 'main')
      await vi.runAllTimersAsync()
      const meta = await promise

      expect(meta).not.toBeNull()
      expect(meta!.lastCommitSha).toBe('sha-newest')
      expect(meta!.lastUpdated).toBe('2026-05-21T10:00:00Z')
      expect(meta!.createdAt).toBe('2025-12-01T07:00:00Z')
      expect(meta!.contributors.map(c => c.login)).toEqual(['alice', 'bob', 'carol'])
      expect(meta!.contributors[0]).toMatchObject({
        login: 'alice',
        name: 'Alice Author',
        email: 'alice@example.com',
        avatarUrl: 'https://avatars.test/alice',
      })
      expect(meta!.contributors[2]).toMatchObject({
        login: 'carol',
        email: '12345+carol@users.noreply.github.com',
      })

      const calledUrl = String(fetchMock.mock.calls[0][0])
      expect(calledUrl).toContain('/repos/sap-tutorials/abap-core-development/commits')
      expect(calledUrl).toContain('path=tutorials%2Fabap-step-1%2Fabap-step-1.md')
      expect(calledUrl).toContain('sha=main')
    })

    it('returns null when path has no commits', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, []))
      global.fetch = fetchMock as any

      const promise = fetchMetaFromRest('repo', 'slug', 'main')
      await vi.runAllTimersAsync()
      const meta = await promise

      expect(meta).toBeNull()
    })

    it('returns null when commits endpoint 404s', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(404, { message: 'Not Found' }))
      global.fetch = fetchMock as any

      const promise = fetchMetaFromRest('repo', 'missing', 'main')
      await vi.runAllTimersAsync()
      const meta = await promise

      expect(meta).toBeNull()
    })
  })

  describe('fetchContributorsFromRestContrib', () => {
    it('targets the -Contribution repo and dedupes by login', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, [
        {
          sha: 'c1',
          commit: { author: { name: 'Doris D', date: '2026-05-01T00:00:00Z', email: 'doris@example.com' } },
          author: { login: 'doris', avatar_url: 'https://avatars.test/doris' },
        },
        {
          sha: 'c2',
          commit: { author: { name: 'Doris D', date: '2026-04-01T00:00:00Z', email: 'doris@example.com' } },
          author: { login: 'doris', avatar_url: 'https://avatars.test/doris' },
        },
        {
          sha: 'c3',
          commit: { author: { name: 'Eve E', date: '2026-03-01T00:00:00Z', email: '99999+eve@users.noreply.github.com' } },
          author: { login: 'eve', avatar_url: 'https://avatars.test/eve' },
        },
      ]))
      global.fetch = fetchMock as any

      const promise = fetchContributorsFromRestContrib('abap-core-development', 'abap-step-1', 'main')
      await vi.runAllTimersAsync()
      const contribs = await promise

      expect(contribs).not.toBeNull()
      expect(contribs!.map(c => c.login)).toEqual(['doris', 'eve'])
      expect(contribs![0]).toMatchObject({ login: 'doris', email: 'doris@example.com' })
      expect(contribs![1]).toMatchObject({ login: 'eve', email: '99999+eve@users.noreply.github.com' })

      const calledUrl = String(fetchMock.mock.calls[0][0])
      expect(calledUrl).toContain('/repos/sap-tutorials/abap-core-development-Contribution/commits')
    })

    it('does not double-suffix when repo already ends with -Contribution', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, []))
      global.fetch = fetchMock as any

      const promise = fetchContributorsFromRestContrib('btp-fiori-elements-Contribution', 'slug', 'main')
      await vi.runAllTimersAsync()
      await promise

      const calledUrl = String(fetchMock.mock.calls[0][0])
      expect(calledUrl).toContain('/repos/sap-tutorials/btp-fiori-elements-Contribution/commits')
      expect(calledUrl).not.toContain('-Contribution-Contribution')
    })

    it('returns null on empty commit list', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mkResponse(200, []))
      global.fetch = fetchMock as any

      const promise = fetchContributorsFromRestContrib('repo', 'slug', 'main')
      await vi.runAllTimersAsync()
      const contribs = await promise

      expect(contribs).toBeNull()
    })
  })

  describe('discoverAllTutorials fallback chain', () => {
    it('falls through to REST when GraphQL returns persistent 502s', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('/graphql')) {
          return mkResponse(502, '<html>502</html>')
        }
        if (u.includes('/orgs/sap-tutorials/repos')) {
          return mkResponse(200, [{ name: 'repo-1', default_branch: 'main' }])
        }
        if (u.includes('/repos/sap-tutorials/repo-1/contents/tutorials')) {
          return mkResponse(200, [{ name: 'rest-tut', type: 'dir' }])
        }
        return mkResponse(404)
      })
      global.fetch = fetchMock as any

      const promise = discoverAllTutorials()
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result.source).toBe('rest')
      expect(result.tutorials).toEqual([
        { slug: 'rest-tut', repo: 'repo-1', branch: 'main' },
      ])

      const graphqlCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/graphql'))
      expect(graphqlCalls.length).toBeGreaterThanOrEqual(2)
    })

    it('returns source: github when GraphQL succeeds (REST never called)', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('/graphql')) {
          return mkResponse(200, {
            data: {
              organization: {
                repositories: {
                  nodes: [
                    {
                      name: 'gh-repo',
                      isArchived: false,
                      isDisabled: false,
                      isFork: false,
                      defaultBranchRef: { name: 'main' },
                      tutorials: {
                        entries: [{ name: 'gh-tut', type: 'tree' }],
                      },
                    },
                  ],
                  pageInfo: { endCursor: null, hasNextPage: false },
                },
              },
            },
          })
        }
        return mkResponse(500, 'should not be reached')
      })
      global.fetch = fetchMock as any

      const promise = discoverAllTutorials()
      await vi.runAllTimersAsync()
      const result = await promise

      expect(result.source).toBe('github')
      expect(result.tutorials).toEqual([
        { slug: 'gh-tut', repo: 'gh-repo', branch: 'main' },
      ])
      const restCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/orgs/sap-tutorials/repos'))
      expect(restCalls).toHaveLength(0)
    })

    it('falls through past REST when both GraphQL and REST fail (and no disk cache, no HANA)', async () => {
      const fetchMock = vi.fn(async (url: string | URL) => {
        const u = String(url)
        if (u.includes('/graphql')) return mkResponse(502)
        if (u.includes('/orgs/sap-tutorials/repos')) return mkResponse(503)
        return mkResponse(404)
      })
      global.fetch = fetchMock as any

      const promise = discoverAllTutorials()
      const expectation = expect(promise).rejects.toThrow(/GraphQL request failed/)
      await vi.runAllTimersAsync()
      await expectation

      const restCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/orgs/sap-tutorials/repos'))
      expect(restCalls.length).toBeGreaterThanOrEqual(2)
    })
  })
})

describe('extractContributors (GraphQL path)', () => {
  it('maps name, login, email, avatarUrl from GraphQL commit nodes', () => {
    const nodes = [
      {
        author: {
          name: 'Alice Author',
          email: 'alice@example.com',
          user: { login: 'alice', avatarUrl: 'https://avatars.test/alice' },
        },
      },
      {
        author: {
          name: 'Bob B',
          email: 'bob@example.com',
          user: { login: 'bob', avatarUrl: 'https://avatars.test/bob' },
        },
      },
    ]

    const result = extractContributors(nodes)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({
      name: 'Alice Author',
      login: 'alice',
      email: 'alice@example.com',
      avatarUrl: 'https://avatars.test/alice',
    })
    expect(result[1]).toEqual({
      name: 'Bob B',
      login: 'bob',
      email: 'bob@example.com',
      avatarUrl: 'https://avatars.test/bob',
    })
  })

  it('deduplicates by login and preserves first occurrence', () => {
    const nodes = [
      {
        author: {
          name: 'Alice Author',
          email: 'alice@example.com',
          user: { login: 'alice', avatarUrl: 'https://avatars.test/alice' },
        },
      },
      {
        author: {
          name: 'Alice Old Name',
          email: 'alice-old@example.com',
          user: { login: 'alice', avatarUrl: 'https://avatars.test/alice' },
        },
      },
    ]

    const result = extractContributors(nodes)

    expect(result).toHaveLength(1)
    expect(result[0].email).toBe('alice@example.com')
  })

  it('falls back to empty string when email is missing from GraphQL response', () => {
    const nodes = [
      {
        author: {
          name: 'Carol',
          user: { login: 'carol', avatarUrl: '' },
        },
      },
    ]

    const result = extractContributors(nodes)

    expect(result).toHaveLength(1)
    expect(result[0].email).toBe('')
  })

  it('passes through noreply GitHub emails without filtering', () => {
    const nodes = [
      {
        author: {
          name: 'Dave',
          email: '12345+dave@users.noreply.github.com',
          user: { login: 'dave', avatarUrl: '' },
        },
      },
    ]

    const result = extractContributors(nodes)

    expect(result[0].email).toBe('12345+dave@users.noreply.github.com')
  })

  it('skips nodes where login is absent', () => {
    const nodes = [
      {
        author: {
          name: 'Ghost',
          email: 'ghost@example.com',
          user: null,
        },
      },
    ]

    const result = extractContributors(nodes)

    expect(result).toHaveLength(0)
  })
})
