// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../App.vue'

function stubFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch)
}

describe('devtoberfest-rules App', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the terms text on 200', async () => {
    stubFetch(200, { text: '# Rules\n\nBe nice.', version: 3 })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-body').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-body').html()).toContain('Rules')
    expect(wrapper.text()).toContain('v3')
  })

  it('shows empty state on 503', async () => {
    stubFetch(503, { error: 'EVENT_NOT_CONFIGURED' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-error').exists()).toBe(false)
  })

  it('shows empty state when text is blank', async () => {
    stubFetch(200, { text: '', version: 1 })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-empty').exists()).toBe(true)
  })

  it('shows error + retry on 500', async () => {
    stubFetch(500, { error: 'INTERNAL' })
    const wrapper = mount(App)
    await flushPromises()
    expect(wrapper.find('.dtf-doc-error').exists()).toBe(true)
    expect(wrapper.find('.dtf-doc-retry').exists()).toBe(true)
  })
})
