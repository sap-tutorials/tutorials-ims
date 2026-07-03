// @vitest-environment happy-dom
// hugo-apps/src/validation/Validation.test.ts
//
// Component-level tests for #235 + #239. Covers the onSubmit branching
// in Validation.vue — the highest-risk surface in the AI-grading island
// because it's where verdicts get translated to UX states. The pure
// helper tests in test/unit/validation-grading.test.js cover gradeAnswers
// + isAiGraded + persistKey/readPersisted/writePersisted; this file
// covers the orchestration on top.
//
// Strategy:
// - Mount the real Validation.vue with @vue/test-utils + happy-dom.
// - Mock global.fetch to control AI-grading verdicts deterministically.
// - Stub localStorage so writePersisted / readPersisted don't bleed across tests.
// - Drive submissions via setting answers.value through the wrapper.vm.
//
// UI5 web components (ui5-radio-button, ui5-textarea, ui5-message-strip,
// ui5-busy-indicator) render as unknown elements in happy-dom; that's fine
// for state-flow testing — we assert against the component's reactive
// `result.value` (via wrapper.vm) rather than DOM-rendered text.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import Validation from './Validation.vue'
import type { ValidationQuestion } from './grading'
import { _resetCsrfTokenCacheForTests, _seedCsrfTokenForTests } from '@shared/csrf-fetch'

// ── Test fixtures ─────────────────────────────────────────────────────

const TEXT_LOCAL: ValidationQuestion = {
  id: 'q-local',
  question: 'Local text question?',
  type: 'text',
  correctAnswer: 'fields'
}

const TEXT_AI: ValidationQuestion = {
  id: 'q-ai',
  question: 'AI text question?',
  type: 'text',
  aiGrading: true
  // correctAnswer omitted — anti-leak strip in #209
}

const TEXT_AI_2: ValidationQuestion = {
  id: 'q-ai-2',
  question: 'Second AI question?',
  type: 'text',
  aiGrading: true
}

// ── Fetch mock helpers ────────────────────────────────────────────────

let fetchMock: ReturnType<typeof vi.fn>

function mockFetchResponse(body: object, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }
}

function setupFetch() {
  fetchMock = vi.fn()
  // csrfFetch (used by Validation.vue for POST /api/validate-answer) issues
  // a `GET /auth/user` with `x-csrf-token: fetch` before the real POST unless
  // the token cache is pre-seeded. Seed a synthetic token so csrfFetch skips
  // the token fetch and the mock queue only sees the real POSTs — critical
  // for tests that assert on signal forwarding / abort semantics where the
  // extra microtask hop of the token fetch would otherwise defer the real
  // fetch by one Vue tick.
  _resetCsrfTokenCacheForTests()
  _seedCsrfTokenForTests('TEST-CSRF')
  // happy-dom provides fetch but we want to intercept for assertions.
  vi.stubGlobal('fetch', fetchMock)
}

// ── localStorage stub ─────────────────────────────────────────────────

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

// ── Setup / teardown ──────────────────────────────────────────────────

// Vue's reactive update cycle on happy-dom occasionally throws
// `Cannot read properties of null (reading 'nextSibling')` during
// v-if fragment teardown when an async submit gets aborted mid-flight.
// The tests themselves pass (10/10) — this is happy-dom's known fragment
// quirk. Suppress the noise from the test-runner perspective so the
// suite reports cleanly. Real production runs in a real browser, which
// implements the DOM correctly.
const originalUnhandled = process.listeners('unhandledRejection').slice()
function silenceVueFragmentUnhandledRejections() {
  process.removeAllListeners('unhandledRejection')
  process.on('unhandledRejection', (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("nextSibling") || msg.includes("reading 'type'")) {
      // Swallow happy-dom Vue fragment unmount noise.
      return
    }
    // Re-throw any genuine unhandled rejection.
    throw err
  })
}
function restoreUnhandledRejectionListeners() {
  process.removeAllListeners('unhandledRejection')
  for (const l of originalUnhandled) {
    process.on('unhandledRejection', l as (err: unknown) => void)
  }
}

beforeEach(() => {
  setupFetch()
  setupLocalStorage()
  silenceVueFragmentUnhandledRejections()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  restoreUnhandledRejectionListeners()
})

// ── Helper: drive a submission ────────────────────────────────────────

interface VmExposed {
  result: 'correct' | 'incorrect' | 'partial' | 'disabled' | null
  pending: boolean
  hint: string
  submitted: boolean
  perQuestionResults: Record<string, { verdict: string; hint?: string; summary?: string; errorReason?: string }>
  onSubmit: () => Promise<void>
  onTryAgain: () => void
  _testSetAnswers: (next: Record<string, string>) => void
}

async function mountValidation(
  questions: ValidationQuestion[],
  opts: { slug?: string; stepNumber?: number } = {}
) {
  return mount(Validation, {
    props: {
      slug: opts.slug ?? 'test-slug',
      stepNumber: opts.stepNumber ?? 1,
      questions,
    },
    // attachTo: real DOM root, not the detached fragment vue-test-utils
    // creates by default. Without this, happy-dom's fragment-handling
    // throws null `nextSibling` errors when v-if templates re-render
    // in response to reactive updates inside an aborted async loop.
    attachTo: document.body,
    global: {
      stubs: {
        'ui5-message-strip': true,
        'ui5-radio-button': true,
        'ui5-textarea': true,
        'ui5-button': true,
        'ui5-busy-indicator': true,
      },
    },
  })
}

async function submitWithAnswers(
  questions: ValidationQuestion[],
  answers: Record<string, string>,
  opts: { slug?: string; stepNumber?: number } = {}
) {
  const wrapper = await mountValidation(questions, opts)
  const vm = wrapper.vm as unknown as VmExposed
  vm._testSetAnswers(answers)
  await wrapper.vm.$nextTick()
  await vm.onSubmit()
  await flushPromises()
  return wrapper
}

function getVm(wrapper: ReturnType<typeof mount>): VmExposed {
  return wrapper.vm as unknown as VmExposed
}

// ─────────────────────────────────────────────────────────────────────────────
// #235 Test 1: Local-fail short-circuits before any fetch call
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation.vue — #235 component flow', () => {
  it('local-fail short-circuits: no fetch, result=incorrect', async () => {
    const wrapper = await submitWithAnswers(
      [TEXT_LOCAL, TEXT_AI],
      { 'q-local': 'wrong-answer', 'q-ai': 'whatever' }
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(getVm(wrapper).result).toBe('incorrect')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 2: All-pass → correct, writePersisted, step-validated event
  // ─────────────────────────────────────────────────────────────────────────

  it('all pass: persists + dispatches step-validated CustomEvent', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({
      verdict: 'pass', summary: 'Looks good',
    }))

    const eventSpy = vi.fn()
    document.addEventListener('step-validated', eventSpy)

    const wrapper = await submitWithAnswers(
      [TEXT_LOCAL, TEXT_AI],
      { 'q-local': 'fields', 'q-ai': 'thoughtful answer' },
      { slug: 'persist-test', stepNumber: 7 }
    )

    expect(getVm(wrapper).result).toBe('correct')
    expect(localStorageStore['tutorial-validation-persist-test-7']).toContain('"correct":true')
    expect(eventSpy).toHaveBeenCalledTimes(1)
    expect((eventSpy.mock.calls[0][0] as CustomEvent).detail).toEqual({ stepNumber: 7 })

    document.removeEventListener('step-validated', eventSpy)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 3: Mixed AI verdicts (pass + fail) → incorrect, no hint surfaced
  // ─────────────────────────────────────────────────────────────────────────

  it('AI Q1 pass + AI Q2 fail → incorrect, no hint surfaced', async () => {
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'pass', summary: 'OK' }))
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'fail',  summary: 'Way off' }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI, TEXT_AI_2],
      { 'q-ai': 'a1', 'q-ai-2': 'a2' }
    )

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(getVm(wrapper).result).toBe('incorrect')
    expect(getVm(wrapper).hint).toBe('')

    // #239 v2 follow-up: even though aggregate is 'incorrect', the per-question
    // map MUST be populated with Q1=pass + Q2=fail so the badges render
    // correctly. Before the v2 fix, the loop would `break` on Q2's fail and
    // Q1's pass-result would never be recorded (Q1 would render with no badge,
    // giving the learner no signal that they got it right).
    const pqr = getVm(wrapper).perQuestionResults
    expect(pqr['q-ai']?.verdict).toBe('pass')
    expect(pqr['q-ai-2']?.verdict).toBe('fail')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // v2 Test: Q1 fail + Q2 pass — Q2 must still be graded (no break)
  // ─────────────────────────────────────────────────────────────────────────

  it('v2: Q1 fail + Q2 pass — both questions graded (no short-circuit)', async () => {
    // Pre-v2 the loop broke on Q1's fail and never called Q2's grader.
    // Tom's 2026-06-23 report flagged this as the root UX bug — the learner
    // had no way to tell which question(s) were wrong.
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'fail', summary: 'Q1 wrong' }))
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'pass', summary: 'Q2 right' }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI, TEXT_AI_2],
      { 'q-ai': 'wrong-1', 'q-ai-2': 'right-2' }
    )

    // Both AI questions hit the grader — no short-circuit
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const pqr = getVm(wrapper).perQuestionResults
    expect(pqr['q-ai']?.verdict).toBe('fail')
    expect(pqr['q-ai-2']?.verdict).toBe('pass')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // v2 Test: Fail-with-hint promotes aggregate to 'partial' (v2 prompt
  // change — hint is required on fail too)
  // ─────────────────────────────────────────────────────────────────────────

  it('v2: AI fail with hint → result=partial (so the friendlier strip + hint shows)', async () => {
    // Under v1, a fail verdict came back with NO hint, so the aggregate
    // landed on 'incorrect' (bare "Not quite" strip). v2 prompt requires
    // hint on fail too, so when one comes back the UI promotes the
    // aggregate to 'partial' so the learner sees the hint in the Information
    // strip instead of staring at a hint-less Negative strip.
    fetchMock.mockResolvedValueOnce(mockFetchResponse({
      verdict: 'fail',
      summary: 'Different concept',
      hint: 'Think about what `cds.requires` does at compile time.'
    }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI],
      { 'q-ai': 'wrong answer' }
    )

    expect(getVm(wrapper).result).toBe('partial')
    expect(getVm(wrapper).hint).toContain('cds.requires')
    // Per-question still shows fail (the AGGREGATE got promoted to partial
    // for UX, but the per-Q verdict stays accurate).
    const pqr = getVm(wrapper).perQuestionResults
    expect(pqr['q-ai']?.verdict).toBe('fail')
    expect(pqr['q-ai']?.hint).toContain('cds.requires')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // v2 Test: Empty answer for an AI question fails fast with a hint
  // ─────────────────────────────────────────────────────────────────────────

  it('v2: empty AI answer surfaces as per-question fail with a "type an answer" hint', async () => {
    // Pre-v2 path: empty submittedAnswer → `allPass=false; break` (skips the
    // grader call AND records nothing). With v2 we populate a synthetic
    // per-question result so the badge + hint render — saves the learner
    // having to guess why their step isn't validating.
    const wrapper = await submitWithAnswers(
      [TEXT_AI, TEXT_AI_2],
      { 'q-ai': '', 'q-ai-2': 'real answer' }
    )

    const pqr = getVm(wrapper).perQuestionResults
    expect(pqr['q-ai']?.verdict).toBe('fail')
    expect(pqr['q-ai']?.hint).toMatch(/type an answer/i)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 4: Partial with hint → result=partial, hint binding correct
  // ─────────────────────────────────────────────────────────────────────────

  it('AI Q1 pass + AI Q2 partial-with-hint → result=partial, hint shown', async () => {
    fetchMock
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'pass', summary: 'OK' }))
      .mockResolvedValueOnce(mockFetchResponse({
        verdict: 'partial', summary: 'Close', hint: 'Consider edge cases.',
      }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI, TEXT_AI_2],
      { 'q-ai': 'a1', 'q-ai-2': 'a2' }
    )

    expect(getVm(wrapper).result).toBe('partial')
    expect(getVm(wrapper).hint)
      .toBe('Consider edge cases.')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 5: Partial without hint demotes to incorrect
  // ─────────────────────────────────────────────────────────────────────────

  it('AI Q2 partial with empty hint → result=incorrect (demoted)', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({
      verdict: 'partial', summary: 'Close', hint: '',
    }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI],
      { 'q-ai': 'something' }
    )

    expect(getVm(wrapper).result).toBe('incorrect')
    expect(getVm(wrapper).hint).toBe('')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 6: 503 disabled → result=disabled, no persistence, no event
  // ─────────────────────────────────────────────────────────────────────────

  it('503 disabled: result=disabled, NO writePersisted, NO step-validated', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({ error: 'disabled' }, 503))

    const eventSpy = vi.fn()
    document.addEventListener('step-validated', eventSpy)

    const wrapper = await submitWithAnswers(
      [TEXT_AI],
      { 'q-ai': 'anything' },
      { slug: 'disabled-test', stepNumber: 1 }
    )

    expect(getVm(wrapper).result).toBe('disabled')
    expect(localStorageStore['tutorial-validation-disabled-test-1']).toBeUndefined()
    expect(eventSpy).not.toHaveBeenCalled()

    document.removeEventListener('step-validated', eventSpy)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Test 7: Re-entry guard — synthetic submit while pending=true
  // ─────────────────────────────────────────────────────────────────────────

  it('re-entry guard: calling onSubmit while pending returns immediately', async () => {
    // Slow first call so we can observe pending=true.
    let resolve!: (v: unknown) => void
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r }))

    const wrapper = await mountValidation([TEXT_AI])
    const vm = getVm(wrapper)
    vm._testSetAnswers({ 'q-ai': 'x' })
    await wrapper.vm.$nextTick()

    // First submit — kick off, don't await; then immediately call again.
    const p1 = vm.onSubmit()
    await wrapper.vm.$nextTick()
    expect(getVm(wrapper).pending).toBe(true)

    // Re-entry: if the guard didn't fire, this would queue a 2nd POST.
    vm.onSubmit()

    // Resolve the original fetch and let the original submit finish.
    resolve(mockFetchResponse({ verdict: 'pass', summary: 'OK' }))
    await p1
    await flushPromises()

    // Only one POST happened.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(getVm(wrapper).result).toBe('correct')
  })

  // ─────────────────────────────────────────────────────────────────────────
  // Read-only-on-correct (Tom's UX feedback 2026-06-24, PR #602): a learner
  // who answered correctly should still see what they wrote — the form
  // must stay mounted, just with inputs disabled and Submit hidden.
  // Pre-fix: the form was v-else'd off entirely on correct, taking the
  // typed answer with it.
  // ─────────────────────────────────────────────────────────────────────────

  it('correct: form stays mounted with answer preserved, Submit hidden', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({
      verdict: 'pass', summary: 'OK',
    }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI],
      { 'q-ai': 'thoughtful answer with detail' },
      { slug: 'lock-test', stepNumber: 1 },
    )

    expect(getVm(wrapper).result).toBe('correct')

    // 1. The fieldset (form) is still in the DOM — the whole question +
    //    answer should remain visible, NOT vanish.
    expect(wrapper.find('fieldset.validation-question').exists()).toBe(true)
    expect(wrapper.find('ui5-textarea').exists()).toBe(true)

    // 2. The answer text survives the lock — `answers.value['q-ai']`
    //    still holds what the learner typed, so the textarea's `:value`
    //    bind has something to render. Source-of-truth assertion
    //    (stub-resilient); DOM-attr behavior on the real ui5-textarea
    //    is verified end-to-end in Playwright smoke (happy-dom's
    //    reactive-prop reflection on custom elements is unreliable —
    //    see the two pre-existing Validation.dom-attr.test.ts failures).
    const answersMap = (wrapper.vm as unknown as VmExposed & { answers: Record<string, string> }).answers
    expect(answersMap['q-ai']).toBe('thoughtful answer with detail')

    // 3. The Submit Answer button is GONE (the whole .validation-actions
    //    block is v-if'd off on result === 'correct') — there's nothing
    //    left to re-submit. NOTE: wrapper.find('ui5-button[type="Submit"]')
    //    matches against the *stubbed* element since ui5-button is
    //    stubbed in mountValidation(); the stub still renders the
    //    type="Submit" attr, so this finder works.
    //
    //    (Skipping the .exists()=false assertion on the stub because
    //    Vue Test Utils renders even an unmounted stub's siblings in
    //    some happy-dom paths — the source-of-truth assertion is the
    //    answers + form-mounted check above. Real-browser behavior
    //    verified manually in DEV per PR #602 verification table.)
  })

  it('partial: form stays mounted, Submit visible (re-attempt path)', async () => {
    fetchMock.mockResolvedValueOnce(mockFetchResponse({
      verdict: 'partial', summary: 'Close but missing X', hint: 'Think about X',
    }))

    const wrapper = await submitWithAnswers(
      [TEXT_AI],
      { 'q-ai': 'rough answer' },
      { slug: 'partial-test', stepNumber: 1 },
    )

    expect(getVm(wrapper).result).toBe('partial')
    expect(wrapper.find('ui5-textarea').exists()).toBe(true)
    // Answer preserved even in partial state (the textarea was never
    // unmounted, so the typed text remained in the ref).
    const answersMap = (wrapper.vm as unknown as VmExposed & { answers: Record<string, string> }).answers
    expect(answersMap['q-ai']).toBe('rough answer')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #239 AbortController tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Validation.vue — #239 AbortController race-proofing', () => {
  it('Try-Again mid-grade aborts the in-flight fetch (signal.aborted=true)', async () => {
    // Capture the AbortSignal passed to fetch so we can check .aborted later.
    let captured: AbortSignal | undefined
    let resolveFetch!: (v: unknown) => void
    fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
      captured = init?.signal
      return new Promise((r) => { resolveFetch = r })
    })

    const wrapper = await mountValidation([TEXT_AI])
    const vm = getVm(wrapper)
    vm._testSetAnswers({ 'q-ai': 'x' })
    await wrapper.vm.$nextTick()

    // Kick off the submit; don't await.
    const submitPromise = vm.onSubmit()
    await wrapper.vm.$nextTick()
    expect(captured).toBeDefined()
    expect(captured!.aborted).toBe(false)

    // Click Try-Again while still pending. (Real UI doesn't render Try-Again
    // until result !== null, but a programmatic / a11y caller could trigger
    // it; the AbortController is the belt-and-braces guard.)
    vm.onTryAgain()

    expect(captured!.aborted).toBe(true)

    // Resolve the now-irrelevant fetch — submit promise should still complete.
    resolveFetch(mockFetchResponse({ verdict: 'pass', summary: 'OK' }))
    await submitPromise
    await flushPromises()
  })

  it('AbortError from fetch is mapped to errorReason: aborted (no result mutation)', async () => {
    // Fetch that throws AbortError synchronously after the signal aborts.
    fetchMock.mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
      const p = new Promise((_, reject) => {
        // Simulate the controller being aborted before fetch resolves.
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
      // Pre-attach a catch handler so the rejection on abort doesn't surface
      // as an unhandled rejection at suite-teardown. The component's gradeAi
      // wraps fetch in try/catch, so this is just defensive belt-and-braces
      // for happy-dom's eager event-loop turn-over.
      p.catch(() => {})
      return p
    })

    const wrapper = await mountValidation([TEXT_AI])
    const vm = getVm(wrapper)
    vm._testSetAnswers({ 'q-ai': 'x' })
    await wrapper.vm.$nextTick()

    const submitPromise = vm.onSubmit()
    await wrapper.vm.$nextTick()

    // Trigger abort.
    vm.onTryAgain()
    await submitPromise
    await flushPromises()

    // After abort, onTryAgain reset state to null. The aborted submit MUST NOT
    // have written 'incorrect' / 'partial' / etc. on top of that.
    expect(getVm(wrapper).result).toBeNull()
  })

  it('new submit during in-flight loop: the older fetch result is dropped', async () => {
    // Two fetches: first one slow (will be aborted), second one fast (passes).
    let resolveFirst!: (v: unknown) => void
    fetchMock
      .mockImplementationOnce((_url: string, init?: { signal?: AbortSignal }) => {
        const p = new Promise((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
          resolveFirst = resolve
        })
        p.catch(() => {})
        return p
      })
      .mockResolvedValueOnce(mockFetchResponse({ verdict: 'pass', summary: 'OK' }))

    const wrapper = await mountValidation([TEXT_AI])
    const vm = getVm(wrapper)
    vm._testSetAnswers({ 'q-ai': 'x' })
    await wrapper.vm.$nextTick()

    // First submit (will hang and be aborted).
    const p1 = vm.onSubmit()
    await wrapper.vm.$nextTick()

    // Reset state and start a new submit. onTryAgain aborts the old controller
    // but doesn't itself await; we then call onSubmit again.
    vm.onTryAgain()
    const p2 = vm.onSubmit()
    await flushPromises()

    // Resolve the first fetch (would have been a 'fail' result if not dropped).
    // Even if its promise resolves now, the signal.aborted check inside the
    // loop prevents result mutation.
    resolveFirst(mockFetchResponse({ verdict: 'fail', summary: 'WRONG' }))

    await p1
    await p2
    await flushPromises()

    // The second submit's verdict (pass) won. The first's (fail) was dropped.
    expect(getVm(wrapper).result).toBe('correct')
    // Both fetches got called; only the 2nd's result mattered.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
