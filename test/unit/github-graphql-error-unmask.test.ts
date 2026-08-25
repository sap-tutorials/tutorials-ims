import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { graphqlRequest, GraphqlError } from '../../scripts/parsers/github'

// Regression guard for the tutorial-discovery workstream (#slug-targeted-delta-rebuild).
// Before this fix, graphqlRequest warn-logged a GraphQL `errors` response and
// returned the null `data`, so callers dereferenced `data.organization` /
// `data.repository` and threw an opaque "Cannot read properties of undefined"
// TypeError — which the outer catch mistook for an outage and silently degraded
// to the slow REST fallback. graphqlRequest must now THROW a GraphqlError that
// carries the real cause, and classify auth/permission failures.

function mockFetchOnce(body: unknown) {
  const res = {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  }
  // @ts-expect-error minimal Response stub for the test
  global.fetch = vi.fn().mockResolvedValue(res)
}

describe('graphqlRequest error unmasking', () => {
  const prevToken = process.env.GITHUB_TOKEN
  beforeEach(() => { process.env.GITHUB_TOKEN = 'test-token' })
  afterEach(() => {
    if (prevToken === undefined) delete process.env.GITHUB_TOKEN
    else process.env.GITHUB_TOKEN = prevToken
    vi.restoreAllMocks()
  })

  it('throws GraphqlError (not a TypeError) when the response carries an errors array', async () => {
    mockFetchOnce({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }], data: null })
    await expect(graphqlRequest('{ organization { name } }')).rejects.toBeInstanceOf(GraphqlError)
  })

  it('includes the GraphQL error type/message in the thrown error', async () => {
    mockFetchOnce({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })
    await expect(graphqlRequest('{ organization { name } }')).rejects.toThrow(/FORBIDDEN.*not accessible by integration/)
  })

  it('flags permission/scope failures as auth errors', async () => {
    mockFetchOnce({ errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] })
    const err = await graphqlRequest('{ organization { name } }').catch(e => e)
    expect(err).toBeInstanceOf(GraphqlError)
    expect((err as GraphqlError).isAuthError).toBe(true)
  })

  it('does NOT flag a non-auth error (e.g. rate/timeout) as an auth error', async () => {
    mockFetchOnce({ errors: [{ type: 'SERVICE_UNAVAILABLE', message: 'temporarily unavailable' }] })
    const err = await graphqlRequest('{ organization { name } }').catch(e => e)
    expect(err).toBeInstanceOf(GraphqlError)
    expect((err as GraphqlError).isAuthError).toBe(false)
  })

  it('throws GraphqlError (not a TypeError) on a null data field with no errors', async () => {
    mockFetchOnce({ data: null })
    await expect(graphqlRequest('{ organization { name } }')).rejects.toBeInstanceOf(GraphqlError)
  })

  it('returns data unchanged on a successful response (no regression)', async () => {
    mockFetchOnce({ data: { organization: { name: 'sap-tutorials' } } })
    await expect(graphqlRequest('{ organization { name } }')).resolves.toEqual({ organization: { name: 'sap-tutorials' } })
  })
})
