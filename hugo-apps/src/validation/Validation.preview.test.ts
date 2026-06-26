// @vitest-environment happy-dom
// hugo-apps/src/validation/Validation.preview.test.ts
//
// [#655] Task 8: Validation.vue must self-govern in preview mode:
//   - Never POST to /api/validate-answer when isPreview=true.
//   - When isPreview + aiInvolved, render PreviewAINotice in place of the
//     question form (the source rules.vr block carries the author signal).
//   - Listen for the tutorial-preview:reset-answers window event and wipe
//     the in-memory + persisted state for this slug.
//
// Existing behavior (prod, isPreview=false) must remain byte-equivalent —
// the last test mounts the widget without the new props and asserts it
// still mounts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Validation from './Validation.vue'

const aiQuestion = {
  id: 'q1',
  question: 'Describe what you learned.',
  type: 'text' as const,
  aiGrading: true,
}

const mcqQuestion = {
  id: 'q2',
  question: 'What is 2+2?',
  type: 'multiple-choice' as const,
  options: ['4', '5'],
  correctAnswer: '4',
}

describe('Validation.vue preview mode', () => {
  let store: Record<string, string>

  beforeEach(() => {
    store = {}
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    })
    // Build the rules-vr-source script the widget reads via rulesBlockId.
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
    const scriptEl = document.createElement('script')
    scriptEl.type = 'application/json'
    scriptEl.id = 'rules-vr-source'
    // jsonify in Hugo wraps the source string in quotes — match that here.
    scriptEl.textContent = JSON.stringify('[VALIDATE_1]\n###Rule\nai-graded\n')
    document.body.appendChild(scriptEl)
  })

  it('isPreview=true + non-AI question: widget renders but does not call fetch', async () => {
    mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [mcqQuestion], isPreview: true, aiInvolved: false },
    })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('isPreview=true + AI question: renders PreviewAINotice (no fetch input field)', async () => {
    const w = mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [aiQuestion], isPreview: true, aiInvolved: true, rulesBlockId: 'rules-vr-source' },
    })
    expect(w.findComponent({ name: 'PreviewAINotice' }).exists()).toBe(true)
  })

  it('listens for tutorial-preview:reset-answers and clears localStorage prefix', async () => {
    store['tutorial-validation-__preview__-1'] = '{"answered": true}'
    mount(Validation, {
      props: { slug: '__preview__', stepNumber: 1, questions: [mcqQuestion], isPreview: true, aiInvolved: false },
      attachTo: document.body,
    })
    window.dispatchEvent(new CustomEvent('tutorial-preview:reset-answers'))
    expect(store['tutorial-validation-__preview__-1']).toBeUndefined()
  })

  it('isPreview=false (default): widget behaves as before (network calls allowed)', async () => {
    // Don't actually fire a submission — just verify the existing prod props
    // shape still works (no required new props).
    const w = mount(Validation, {
      props: { slug: 'some-slug', stepNumber: 1, questions: [mcqQuestion] },
    })
    expect(w.exists()).toBe(true)
  })
})
