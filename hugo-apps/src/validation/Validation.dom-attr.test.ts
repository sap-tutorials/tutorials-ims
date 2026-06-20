// @vitest-environment happy-dom
// hugo-apps/src/validation/Validation.dom-attr.test.ts
//
// Regression test for the Submit-Answer-disabled-at-mount bug.
//
// Background:
//   On the deployed DEV site, every tutorial with a [VALIDATE_N] quiz
//   rendered a permanently-disabled "Submit Answer" button. Reproduced
//   live at /tutorials/abap-create-project step 5. Verified with
//   Playwright that setAttribute('disabled', '') makes a UI5 web
//   component button report disabled === true (UI5 reads attribute
//   *presence* as truthy, regardless of value).
//
// Root cause:
//   Vue 3's runtime DOM patcher emits `disabled=""` as an attribute
//   when binding `:disabled="false"` to an *unknown / custom* element.
//   For native form controls Vue knows to remove the attribute on a
//   falsy bind, but it can't know that for arbitrary custom elements
//   so it serializes the boolean. UI5 then treats the empty-string
//   attribute as "disabled". The button is disabled at mount, before
//   the user can interact.
//
// Why Validation.test.ts doesn't catch it:
//   That suite stubs every ui5-* element to a generic stub component
//   and asserts only against `wrapper.vm.result`. It never inspects
//   the rendered DOM attribute on a real UI5 element.
//
// What this test does:
//   - Mounts Validation.vue *without* stubbing ui5-button. happy-dom
//     treats unregistered custom elements as plain HTMLElements; that's
//     enough to observe whether Vue emits the `disabled` attribute.
//   - Asserts hasAttribute('disabled') === false at mount when pending=false.
//   - Drives pending=true via the exposed _testSetPending setter and
//     asserts hasAttribute('disabled') === true after a re-render.
//
// On the broken `:disabled="pending"` form this test fails because
// Vue serializes `disabled=""` even when pending=false. On the fixed
// `v-bind="pending ? { disabled: true } : {}"` form the attribute is
// absent when pending=false and present when pending=true.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Validation from './Validation.vue'
import type { ValidationQuestion } from './grading'

// ── Test fixtures (mirror Validation.test.ts to stay consistent) ─────

const TEXT_AI: ValidationQuestion = {
  id: 'q-ai',
  question: 'AI text question?',
  type: 'text',
  aiGrading: true
}

// ── localStorage stub (Validation.vue calls readPersisted on mount) ──

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

// ── Helper: mount with NO stubs for ui5-button so we can inspect the
// real rendered attribute. Other ui5-* elements are stubbed to keep
// the rest of the suite quiet — we only care about ui5-button here. ──

interface VmExposed {
  pending: boolean
  _testSetPending: (next: boolean) => void
}

async function mountValidation(questions: ValidationQuestion[]) {
  return mount(Validation, {
    props: {
      slug: 'dom-attr-test',
      stepNumber: 1,
      questions,
    },
    attachTo: document.body,
    global: {
      stubs: {
        // Note: ui5-button is NOT stubbed — we want the real custom-element
        // render so we can assert hasAttribute('disabled') against the
        // DOM Vue actually produces.
        'ui5-message-strip': true,
        'ui5-radio-button': true,
        'ui5-textarea': true,
        'ui5-busy-indicator': true,
      },
    },
  })
}

// ─────────────────────────────────────────────────────────────────────
// Regression: Submit Answer button must NOT have a `disabled` attribute
// at mount when pending is false. This is the exact failure mode users
// hit on /tutorials/abap-create-project step 5.
// ─────────────────────────────────────────────────────────────────────

describe('Validation.vue — boolean-attribute coercion on ui5-button', () => {
  it('Submit Answer has no `disabled` attribute at mount (pending=false)', async () => {
    const wrapper = await mountValidation([TEXT_AI])
    await wrapper.vm.$nextTick()

    const submitBtn = wrapper.find('ui5-button[type="Submit"]').element
    expect(submitBtn).toBeTruthy()

    // The bug surfaces here: with `:disabled="pending"` Vue emits
    // disabled="" on an unknown element even when pending=false, and
    // UI5 reads attribute presence as truthy.
    expect(submitBtn.hasAttribute('disabled')).toBe(false)
  })

  it('Submit Answer gains the `disabled` attribute when pending=true', async () => {
    const wrapper = await mountValidation([TEXT_AI])
    const vm = wrapper.vm as unknown as VmExposed

    // Sanity: starts unset.
    let submitBtn = wrapper.find('ui5-button[type="Submit"]').element
    expect(submitBtn.hasAttribute('disabled')).toBe(false)

    // Force pending=true through the exposed test setter and wait for
    // Vue's reactive update cycle to flush.
    vm._testSetPending(true)
    await wrapper.vm.$nextTick()

    submitBtn = wrapper.find('ui5-button[type="Submit"]').element
    expect(submitBtn.hasAttribute('disabled')).toBe(true)
  })

  it('Toggling pending false → true → false removes the attribute again', async () => {
    const wrapper = await mountValidation([TEXT_AI])
    const vm = wrapper.vm as unknown as VmExposed

    // false → true
    vm._testSetPending(true)
    await wrapper.vm.$nextTick()
    expect(
      wrapper.find('ui5-button[type="Submit"]').element.hasAttribute('disabled')
    ).toBe(true)

    // true → false: this is the exact transition that masquerades as a
    // freshly-mounted button on the broken form. The attribute MUST be
    // gone, not retained as disabled="" or disabled="false".
    vm._testSetPending(false)
    await wrapper.vm.$nextTick()
    expect(
      wrapper.find('ui5-button[type="Submit"]').element.hasAttribute('disabled')
    ).toBe(false)
  })
})
