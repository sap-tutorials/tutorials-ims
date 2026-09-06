// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useAtlasData } from '../composables/useAtlasData.js'
import type { AtlasPayload } from '../types.js'

const FIXTURE: AtlasPayload = {
  channels: [{
    id: 'ch-1', name: 'SAP CAP', url: 'https://cap.cloud.sap',
    purpose: 'CAP tutorials', ownerType: 'SAP_Official',
    subscribers: 1000, githubStars: null,
    focusAreas: ['CAP', 'BTP'], topicTags: [],
  }],
  buildAt: '2026-09-05T00:00:00.000Z',
}

function injectPayload(data: AtlasPayload | string) {
  const el = document.createElement('script')
  el.id = 'atlas-payload'
  el.type = 'application/json'
  el.textContent = typeof data === 'string' ? data : JSON.stringify(data)
  document.body.appendChild(el)
}

describe('useAtlasData', () => {
  beforeEach(() => {
    document.getElementById('atlas-payload')?.remove()
  })

  it('reads payload from inline <script id="atlas-payload"> element', async () => {
    injectPayload(FIXTURE)
    const { payload, hasData, error } = useAtlasData()
    await nextTick()
    expect(error.value).toBeNull()
    expect(hasData.value).toBe(true)
    expect(payload.value?.channels).toHaveLength(1)
    expect(payload.value?.channels[0].id).toBe('ch-1')
    expect(payload.value?.buildAt).toBe('2026-09-05T00:00:00.000Z')
  })

  it('sets error and leaves payload null when inline JSON is malformed', async () => {
    injectPayload('NOT_VALID_JSON{')
    const { payload, error } = useAtlasData()
    await nextTick()
    expect(payload.value).toBeNull()
    expect(error.value).toBeInstanceOf(Error)
  })

  it('hasData is false when inline element is absent and no inline fetch fires', async () => {
    // No inline element, no window (non-browser env).
    // Simulate: just construct without element — hasData stays false until async resolves.
    const { hasData } = useAtlasData()
    // In happy-dom window exists, so fetch fires. But with no inline and no mock,
    // fetch to /build/channel-atlas will fail.
    // We only test the initial state here.
    expect(hasData.value).toBe(false)
  })
})
