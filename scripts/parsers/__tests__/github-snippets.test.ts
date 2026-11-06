import { describe, it, expect, vi, afterEach } from 'vitest'

describe('fetchSnippets', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('returns empty map when SNIPPETS_ENABLED_REPOS is unset', async () => {
    delete process.env.SNIPPETS_ENABLED_REPOS
    const { fetchSnippets } = await import('../github.js')
    const result = await fetchSnippets(['any-repo'], 'token')
    expect(result.size).toBe(0)
  })

  it('returns empty map when SNIPPETS_ENABLED_REPOS is empty string', async () => {
    process.env.SNIPPETS_ENABLED_REPOS = ''
    const { fetchSnippets } = await import('../github.js')
    const result = await fetchSnippets(['any-repo'], 'token')
    expect(result.size).toBe(0)
    delete process.env.SNIPPETS_ENABLED_REPOS
  })

  it('fetches snippets only for opted-in repos', async () => {
    process.env.SNIPPETS_ENABLED_REPOS = 'hana-cloud-tutorial'
    // Mock fetch to return a file listing for hana-cloud-tutorial/_snippets
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/contents/_snippets') && url.includes('hana-cloud-tutorial') && !url.includes('.md')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([
          { name: 'install-btp.md', download_url: 'https://raw.example.com/install-btp.md', sha: 'abc123', type: 'file' }
        ]), headers: new Headers() })
      }
      if (url.includes('install-btp.md')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('Install BTP\r\n'), headers: new Headers() })
      }
      // tutorial-snippets shared repo returns 404
      if (url.includes('tutorial-snippets')) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), headers: new Headers() })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), headers: new Headers() })
    }) as any
    const { fetchSnippets } = await import('../github.js')
    const result = await fetchSnippets(['hana-cloud-tutorial', 'other-repo'], 'token')
    expect(result.has('hana-cloud-tutorial/_snippets/install-btp.md')).toBe(true)
    expect(result.get('hana-cloud-tutorial/_snippets/install-btp.md')).toBe('Install BTP\n')
    expect(result.has('other-repo/_snippets/install-btp.md')).toBe(false)
    delete process.env.SNIPPETS_ENABLED_REPOS
  })

  it('keys shared snippets under shared/ prefix', async () => {
    process.env.SNIPPETS_ENABLED_REPOS = 'hana-cloud-tutorial'
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('hana-cloud-tutorial') && url.includes('/contents/_snippets') && !url.includes('.md')) {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), headers: new Headers() })
      }
      if (url.includes('tutorial-snippets') && url.includes('/contents/_snippets') && !url.includes('.md')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([
          { name: 'cf-cli.md', download_url: 'https://raw.example.com/cf-cli.md', sha: 'def456', type: 'file' }
        ]), headers: new Headers() })
      }
      if (url.includes('cf-cli.md')) {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('Install CF CLI'), headers: new Headers() })
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null), headers: new Headers() })
    }) as any
    const { fetchSnippets } = await import('../github.js')
    const result = await fetchSnippets(['hana-cloud-tutorial'], 'token')
    expect(result.has('shared/cf-cli')).toBe(true)
    delete process.env.SNIPPETS_ENABLED_REPOS
  })
})
