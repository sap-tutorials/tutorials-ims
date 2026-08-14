// @vitest-environment happy-dom
// hugo-apps/src/validation/Validation.checked-attr.test.ts
//
// Regression test for the "every option pre-selected at mount" bug (#1774).
//
// Background:
//   On the deployed site, the multi-select quiz at
//   /tutorials/hana-cloud-mission-trial-1 step 4 rendered EVERY checkbox
//   already checked at mount — including the distractor. Submitting the
//   as-rendered form graded the selected set (all 5) against the correct
//   set (4) and always returned "Not quite — give it another try."
//   Reproduced live with Playwright: each <ui5-checkbox> had the `checked`
//   attribute present (hasAttribute('checked') === true) while the
//   component's `answers` model was empty.
//
// Root cause:
//   Same UI5 boolean-attribute coercion documented for `disabled` in
//   Validation.dom-attr.test.ts. The template bound `:checked="isOptionSelected(...)"`.
//   Vue 3's runtime patcher emits `checked=""` on a custom element even
//   when the bound value is false, and UI5 reads attribute *presence* as
//   truthy — so an unselected option renders as selected. The `disabled`
//   binding on the same elements was already worked around with the
//   `v-bind="cond ? { attr: true } : {}"` pattern; `:checked` was not.
//
// What this test does:
//   - Mounts Validation.vue WITHOUT stubbing ui5-checkbox / ui5-radio-button.
//     happy-dom treats unregistered custom elements as plain HTMLElements;
//     that's enough to observe whether Vue emits the `checked` attribute.
//   - Asserts NO option carries a `checked` attribute at mount (answers empty).
//   - Asserts that after selecting an option through the exposed test setter,
//     ONLY the selected option carries the attribute.
//
// On the broken `:checked="isOptionSelected(...)"` form these fail because
// Vue serializes `checked=""` on every option regardless of value.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Validation from './Validation.vue'
import type { ValidationQuestion } from './grading'

const MULTI: ValidationQuestion = {
  id: 'validate-1',
  question: 'Pick the correct statements',
  type: 'multiple-choice',
  choiceMode: 'multiple',
  options: ['Alpha', 'Bravo', 'Charlie'],
  correctAnswers: ['Alpha', 'Bravo'],
}

const SINGLE: ValidationQuestion = {
  id: 'validate-1',
  question: 'Pick the correct statement',
  type: 'multiple-choice',
  choiceMode: 'single',
  options: ['Alpha', 'Bravo', 'Charlie'],
  correctAnswer: 'Alpha',
}

let localStorageStore: Record<string, string>

function setupLocalStorage() {
  localStorageStore = {}
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => localStorageStore[k] ?? null,
    setItem: (k: string, v: string) => { localStorageStore[k] = v },
    removeItem: (k: string) => { delete localStorageStore[k] },
    clear: () => { localStorageStore = {} },
  })
}

beforeEach(() => {
  setupLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface VmExposed {
  _testSetAnswers: (next: Record<string, string | string[]>) => void
}

async function mountValidation(questions: ValidationQuestion[]) {
  return mount(Validation, {
    props: {
      slug: 'checked-attr-test',
      stepNumber: 1,
      questions,
    },
    attachTo: document.body,
    global: {
      stubs: {
        // ui5-checkbox / ui5-radio-button are NOT stubbed — we assert the
        // real custom-element render Vue actually produces.
        'ui5-message-strip': true,
        'ui5-textarea': true,
        'ui5-busy-indicator': true,
        'ui5-button': true,
      },
    },
  })
}

describe('Validation.vue — boolean-attribute coercion on ui5-checkbox (#1774)', () => {
  it('no checkbox has a `checked` attribute at mount (answers empty)', async () => {
    const wrapper = await mountValidation([MULTI])
    await wrapper.vm.$nextTick()

    const boxes = wrapper.findAll('ui5-checkbox')
    expect(boxes.length).toBe(3)
    for (const box of boxes) {
      expect(box.element.hasAttribute('checked')).toBe(false)
    }
  })

  it('only the selected option carries the `checked` attribute', async () => {
    const wrapper = await mountValidation([MULTI])
    const vm = wrapper.vm as unknown as VmExposed

    vm._testSetAnswers({ 'validate-1': ['Bravo'] })
    await wrapper.vm.$nextTick()

    const boxes = wrapper.findAll('ui5-checkbox')
    const checkedTexts = boxes
      .filter(b => b.element.hasAttribute('checked'))
      .map(b => b.element.getAttribute('text'))
    expect(checkedTexts).toEqual(['Bravo'])
  })
})

describe('Validation.vue — boolean-attribute coercion on ui5-radio-button (#1774)', () => {
  it('no radio has a `checked` attribute at mount (answers empty)', async () => {
    const wrapper = await mountValidation([SINGLE])
    await wrapper.vm.$nextTick()

    const radios = wrapper.findAll('ui5-radio-button')
    expect(radios.length).toBe(3)
    for (const radio of radios) {
      expect(radio.element.hasAttribute('checked')).toBe(false)
    }
  })

  it('only the selected radio carries the `checked` attribute', async () => {
    const wrapper = await mountValidation([SINGLE])
    const vm = wrapper.vm as unknown as VmExposed

    vm._testSetAnswers({ 'validate-1': 'Charlie' })
    await wrapper.vm.$nextTick()

    const radios = wrapper.findAll('ui5-radio-button')
    const checkedTexts = radios
      .filter(r => r.element.hasAttribute('checked'))
      .map(r => r.element.getAttribute('text'))
    expect(checkedTexts).toEqual(['Charlie'])
  })
})
