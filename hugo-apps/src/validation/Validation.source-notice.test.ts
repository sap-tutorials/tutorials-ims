// @vitest-environment happy-dom
// hugo-apps/src/validation/Validation.source-notice.test.ts
//
// Tests for #2800 Task 6: learner-facing source notice under video quizzes.
// When a quiz step carries questionSource='captions'|'description' (set by
// Task 5 when the questions were auto-generated from video content), a small
// <p class="validation-source-notice"> renders below the form.  Hand-authored
// quizzes (questionSource absent) show nothing.

import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import Validation from './Validation.vue'
import type { ValidationQuestion } from './grading'

// Minimal question fixture — local-graded so no fetch mock needed.
const Q: ValidationQuestion = {
  id: 'q-src',
  question: 'What is CAP?',
  type: 'text',
  correctAnswer: 'cloud application programming',
}

function mountWithSource(questionSource?: 'captions' | 'description') {
  return mount(Validation, {
    props: {
      slug: 'test-slug',
      stepNumber: 1,
      questions: [Q],
      ...(questionSource !== undefined ? { questionSource } : {}),
    },
    attachTo: document.body,
    global: {
      stubs: {
        'ui5-message-strip': true,
        'ui5-radio-button': true,
        'ui5-checkbox': true,
        'ui5-textarea': true,
        'ui5-button': true,
        'ui5-busy-indicator': true,
      },
    },
  })
}

describe('Validation.vue — #2800 source notice', () => {
  it('questionSource=captions renders the captions notice', async () => {
    const wrapper = mountWithSource('captions')
    const notice = wrapper.find('.validation-source-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe("Questions generated from the video's captions")
  })

  it('questionSource=description renders the description notice', async () => {
    const wrapper = mountWithSource('description')
    const notice = wrapper.find('.validation-source-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toBe('Questions generated from the video description')
  })

  it('questionSource absent renders NO notice element', async () => {
    const wrapper = mountWithSource()
    expect(wrapper.find('.validation-source-notice').exists()).toBe(false)
  })
})
