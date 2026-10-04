import { describe, it, expect, vi, afterEach } from 'vitest'
import { postQuarantineSnapshot } from '../scripts/validate-tutorials'

const events = [{ slug: 'a', sourceFile: 'a.md', sourceRepo: 'r', reason: 'x' }]

afterEach(() => { vi.restoreAllMocks() })

describe('postQuarantineSnapshot (fail-open guard)', () => {
  it('no-ops when report !== full', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: '' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no-ops when base or key missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await postQuarantineSnapshot(events, { base: '', key: 'k', report: 'full' })
    await postQuarantineSnapshot(events, { base: 'http://x', key: '', report: 'full' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts with Bearer auth when fully configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ snapshotId: 's', eventCount: 1 }), { status: 201 }) as any
    )
    await postQuarantineSnapshot(events, {
      base: 'http://x/', key: 'k', runId: '42', workflowUrl: 'http://x/runs/42', report: 'full'
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('http://x/content/quarantine-events')
    expect((init as any).headers.Authorization).toBe('Bearer k')
    const body = JSON.parse((init as any).body)
    expect(body.buildMode).toBe('full')
    expect(body.events).toHaveLength(1)
  })

  it('never throws when fetch rejects (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await expect(
      postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: 'full' })
    ).resolves.toBeUndefined()
  })

  it('never throws when server returns non-ok (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }) as any)
    await expect(
      postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: 'full' })
    ).resolves.toBeUndefined()
  })
})
