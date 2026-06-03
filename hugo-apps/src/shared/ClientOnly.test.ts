// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { renderToString } from 'vue/server-renderer'
import { createSSRApp, h } from 'vue'
import ClientOnly from './ClientOnly.vue'

describe('<ClientOnly>', () => {
  it('renders nothing in SSR', async () => {
    const html = await renderToString(createSSRApp({
      render: () => h(ClientOnly, null, { default: () => h('span', 'should-not-ssr') }),
    }))
    expect(html).not.toContain('should-not-ssr')
  })

  it('renders slot after onMounted on the client', async () => {
    const wrapper = mount(ClientOnly, {
      slots: { default: '<span>visible-after-mount</span>' },
    })
    // happy-dom synchronously fires onMounted; flush microtasks.
    await wrapper.vm.$nextTick()
    expect(wrapper.html()).toContain('visible-after-mount')
  })
})
