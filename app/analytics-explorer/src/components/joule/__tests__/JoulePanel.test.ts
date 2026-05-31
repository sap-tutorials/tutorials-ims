// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const sendMock = vi.fn(async () => {})
const messagesRef = ref<any[]>([])
const streamingRef = ref(false)

vi.mock('../../../composables/useJouleChat', () => ({
  useJouleChat: () => ({
    messages: messagesRef,
    streaming: streamingRef,
    error: ref(null),
    send: sendMock,
    cancel: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('../../../composables/useJouleContext', () => ({
  useJouleContext: () => ({
    setLastResult: vi.fn(),
    build: vi.fn(async () => ({ kind: 'admin', tool: 'analytics-builder' })),
    lastResult: ref(null),
  }),
}))

import JoulePanel from '../JoulePanel.vue'

beforeEach(() => {
  sendMock.mockClear()
  messagesRef.value = []
  streamingRef.value = false
})

describe('JoulePanel', () => {
  it('renders empty-state hint when no messages', () => {
    const w = mount(JoulePanel)
    expect(w.text()).toMatch(/ask me/i)
  })

  it('emits close when close button clicked', async () => {
    const w = mount(JoulePanel)
    await w.find('[data-test="joule-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('calls send with built pageContext when Send clicked', async () => {
    const w = mount(JoulePanel)
    await w.find('textarea').setValue('summarize this')
    await w.find('[data-test="joule-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledWith('summarize this', expect.objectContaining({ kind: 'admin', tool: 'analytics-builder' }))
  })

  it('forwards view-in-builder from JouleMessage', async () => {
    messagesRef.value = [{
      id: 'm1', role: 'assistant', kind: 'generated-query',
      spec: { version: 1, from: { entity: 'X', alias: 'x' } },
      sql: 'SELECT 1', explanation: '', preview: { columns: [], rows: [], truncated: false }, errors: [],
    }]
    const w = mount(JoulePanel)
    await w.find('[data-test="view-in-builder"]').trigger('click')
    expect(w.emitted('view-in-builder')).toBeTruthy()
  })

  it('shows Stop button while streaming', async () => {
    streamingRef.value = true
    const w = mount(JoulePanel)
    expect(w.find('[data-test="joule-stop"]').exists()).toBe(true)
  })
})
