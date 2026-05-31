// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JouleMessage from '../JouleMessage.vue'

describe('JouleMessage', () => {
  it('renders user text', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'user', text: 'hello' } as any },
    })
    expect(w.text()).toContain('hello')
    expect(w.classes()).toContain('joule-msg-user')
  })

  it('renders assistant text', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'text', text: 'hi back' } as any },
    })
    expect(w.text()).toContain('hi back')
  })

  it('renders generated-query with SQL + View in builder button', () => {
    const w = mount(JouleMessage, {
      props: {
        message: {
          id: 'm1', role: 'assistant', kind: 'generated-query',
          spec: { version: 1, from: { entity: 'Users', alias: 'u' } },
          sql: 'SELECT * FROM USERS',
          explanation: 'all users',
          preview: { columns: ['id'], rows: [['u1']], truncated: false },
          errors: [],
        } as any,
      },
    })
    expect(w.text()).toContain('SELECT * FROM USERS')
    expect(w.find('[data-test="view-in-builder"]').exists()).toBe(true)
  })

  it('emits view-in-builder when button clicked', async () => {
    const w = mount(JouleMessage, {
      props: {
        message: {
          id: 'm1', role: 'assistant', kind: 'generated-query',
          spec: { version: 1, from: { entity: 'Users', alias: 'u' } },
          sql: 'SELECT 1', explanation: '', preview: { columns: [], rows: [], truncated: false }, errors: [],
        } as any,
      },
    })
    await w.find('[data-test="view-in-builder"]').trigger('click')
    expect(w.emitted('view-in-builder')).toBeTruthy()
    expect((w.emitted('view-in-builder')![0][0] as any).from.entity).toBe('Users')
  })

  it('renders explanation summary', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'explanation', summary: 'There are 7 rows.' } as any },
    })
    expect(w.text()).toContain('There are 7 rows.')
  })

  it('renders error with error class', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'error', text: 'boom' } as any },
    })
    expect(w.text()).toContain('boom')
    expect(w.classes()).toContain('joule-msg-error')
  })
})
