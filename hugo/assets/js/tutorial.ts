import { initMermaid } from './mermaid-bootstrap'
import { csrfFetch } from './csrf-fetch'
import { getChoice, setChoice, onChange, resolveChoice } from './sync-groups'
import { initTableEnhance } from './table-enhance'

// NOTE: copyCodeBlock (the "Copy code" button handler) now lives in the
// site-wide code-copy.ts, loaded on every page from baseof.html. The
// render-codeblock.html hook emits the button on all pages, not just
// tutorials, so its handler must not be scoped to this tutorial-only bundle
// (issue #2226).

// Event delegation
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  const stepLink = target.closest('a[href^="#step-"]') as HTMLAnchorElement | null
  if (stepLink) {
    const m = stepLink.getAttribute('href')!.match(/^#step-(\d+)$/)
    if (m) expandStep(m[1])
  }
  const stepHeader = target.closest('[data-action="toggle-step"]')
  if (stepHeader) { toggleStep(stepHeader as HTMLElement); return }
  const doneBtn = target.closest('[data-action="mark-done"]')
  if (doneBtn) { markDone(doneBtn as HTMLButtonElement); return }
  const skipBtn = target.closest('[data-action="skip-step"]')
  if (skipBtn) { skipStep(skipBtn as HTMLButtonElement); return }
  const tabBtn = target.closest('[role="tab"]')
  if (tabBtn) { activateTab(tabBtn as HTMLButtonElement, true); return }
  const codeToggle = target.closest('[data-action="toggle-code"]')
  if (codeToggle) { toggleCodeBlock(codeToggle as HTMLButtonElement); return }
  const printBtn = target.closest('[data-action="print-tutorial"]')
  if (printBtn) { void printTutorial(); return }
})

// --- Lazy video embeds (#2362-adjacent) ---
// Step iframes (YouTube/Vimeo/openSAP/sapvideo) are emitted by the parser with
// `src` moved to `data-src` + a `lazy-embed` class (scripts/parsers/sanitize-
// html.ts). Reason: steps 2+ start `hidden` (display:none), so an eagerly-
// loaded iframe initializes at 0×0 and the provider picks a low-resolution
// poster keyed to that size — which it never upgrades when the step expands.
// Swapping data-src → src only once the body is visible lets the iframe size
// correctly and the provider serve a full-res poster (and avoids loading every
// buried video up front). Idempotent: an already-activated iframe has no
// data-src, so re-reveal is a no-op.
function activateLazyEmbeds(root: ParentNode) {
  root.querySelectorAll<HTMLIFrameElement>('iframe.lazy-embed[data-src]').forEach((frame) => {
    frame.src = frame.dataset.src!
    delete frame.dataset.src
    frame.classList.remove('lazy-embed')
  })
}

function toggleCodeBlock(btn: HTMLButtonElement) {
  const block = btn.closest('.code-block')
  if (!block) return
  const body = block.querySelector('.code-block-body') as HTMLElement | null
  if (!body) return
  const expanded = btn.getAttribute('aria-expanded') === 'true'
  if (expanded) {
    body.dataset.collapsed = 'true'
    btn.setAttribute('aria-expanded', 'false')
  } else {
    delete body.dataset.collapsed
    btn.setAttribute('aria-expanded', 'true')
  }
}

function toggleStep(header: HTMLElement) {
  const step = header.closest('.tutorial-step')
  if (!step) return
  const body = step.querySelector('.step-body') as HTMLElement
  if (!body) return
  const icon = step.querySelector('.step-toggle-icon')
  body.hidden = !body.hidden
  if (!body.hidden) activateLazyEmbeds(body)
  if (icon) icon.textContent = body.hidden ? '+' : '—'
  updateActiveTocItem()
}

function expandStep(stepNum: string): HTMLElement | null {
  const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`) as HTMLElement | null
  if (!step) return null
  const body = step.querySelector('.step-body') as HTMLElement | null
  if (!body) return step
  if (body.hidden) {
    body.hidden = false
    activateLazyEmbeds(body)
    const icon = step.querySelector('.step-toggle-icon')
    if (icon) icon.textContent = '—'
    updateActiveTocItem()
  }
  return step
}

function scrollToStepHash() {
  const m = location.hash.match(/^#step-(\d+)$/)
  if (!m) return
  const step = expandStep(m[1])
  if (step) step.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function initStepHashNavigation() {
  if (location.hash.startsWith('#step-')) scrollToStepHash()
  window.addEventListener('hashchange', scrollToStepHash)
}

function expandAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) { body.hidden = false; activateLazyEmbeds(body) }
    if (icon) icon.textContent = '—'
  })
  updateActiveTocItem()
}

function collapseAllSteps() {
  document.querySelectorAll('.tutorial-step').forEach(step => {
    const body = step.querySelector('.step-body') as HTMLElement
    const icon = step.querySelector('.step-toggle-icon')
    if (body) body.hidden = true
    if (icon) icon.textContent = '+'
  })
  updateActiveTocItem()
}

// --- Sidebar TOC active highlighting ---
// U11: when reading-progress.ts initializes scrollspy on a page, it sets
// documentElement.dataset.scrollspy='active'. We bail here so the two don't
// fight over .step-toc-item.active. The expand-based fallback below is kept
// for non-tutorial pages and as a pre-scroll initial paint on cold loads.
function updateActiveTocItem() {
  if (document.documentElement.dataset.scrollspy === 'active') return
  document.querySelectorAll('.step-toc-item').forEach(item => item.classList.remove('active'))
  const expandedStep = document.querySelector('.tutorial-step .step-body:not([hidden])')
  if (!expandedStep) return
  const step = expandedStep.closest('.tutorial-step')
  if (!step) return
  const stepNum = (step as HTMLElement).dataset.step
  if (stepNum) {
    const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
    if (tocItem) tocItem.classList.add('active')
  }
}

// Expose globally for onclick handlers in template
;(window as any).expandAllSteps = expandAllSteps
;(window as any).collapseAllSteps = collapseAllSteps

// --- Tab switching ---
//
// activateTab(btn, notifySync): selects `btn` within its strip.
//   - Updates is-selected class, aria-selected, tabindex (roving).
//   - Shows/hides panels.
//   - When notifySync=true AND the strip carries data-sync-key, persists the
//     choice via setChoice() so other strips of the same key follow.
//
// Strips with NO data-sync-key behave exactly as before (independent tabs).

function activateTab(btn: HTMLButtonElement, notifySync: boolean) {
  const container = btn.closest('[data-component="tabs"]')
  if (!container) return
  const index = btn.dataset.tabIndex

  // Update all tabs in the strip
  container.querySelectorAll<HTMLElement>('[role="tab"]').forEach(t => {
    const active = t === btn
    t.classList.toggle('is-selected', active)
    t.setAttribute('aria-selected', active ? 'true' : 'false')
    t.setAttribute('tabindex', active ? '0' : '-1')
  })

  // Show/hide panels
  container.querySelectorAll('[data-tab-panel]').forEach(p => {
    const panel = p as HTMLElement
    panel.hidden = panel.dataset.tabPanel !== index
  })

  // Sync: persist when the strip is wired to a sync key
  if (notifySync) {
    const list = container.querySelector('[data-sync-key]') as HTMLElement | null
    const syncKey = list?.dataset.syncKey
    if (syncKey) {
      const syncValue = btn.dataset.syncValue
      if (syncValue) setChoice(syncKey, syncValue)
    }
  }
}

/** Select the tab whose data-sync-value matches `value`; injects a placeholder when not found. */
function applyChoiceToStrip(strip: Element, value: string) {
  const btn = strip.querySelector<HTMLButtonElement>(`[role="tab"][data-sync-value="${CSS.escape(value)}"]`)
  if (btn) {
    activateTab(btn, false)
    // Remove any placeholder left from a prior missing-value state
    strip.querySelector('[data-sync-missing]')?.remove()
  } else {
    // #2820: no silent substitution — inject a placeholder naming the missing value
    const existing = strip.querySelector('[data-sync-missing]')
    if (!existing) {
      const available = Array.from(
        strip.querySelectorAll<HTMLElement>('[role="tab"][data-sync-value]')
      ).map(b => b.dataset.syncValue ?? '').filter(Boolean)

      const placeholder = document.createElement('div')
      placeholder.setAttribute('data-sync-missing', '')
      placeholder.setAttribute('data-sync-missing-placeholder', '')
      placeholder.className = 'option-tabs__missing-placeholder'
      placeholder.textContent =
        `"${value}" is not available in this section. ` +
        (available.length > 0 ? `Available options: ${available.join(', ')}.` : 'No options available.')
      strip.appendChild(placeholder)
    }
  }
}

/** Keydown handler for roving tabindex in tab strips (ArrowLeft/Right/Home/End). */
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement
  if (target.getAttribute('role') !== 'tab') return
  const container = target.closest('[data-component="tabs"]')
  if (!container) return
  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
  const currentIdx = tabs.indexOf(target as HTMLButtonElement)
  if (currentIdx === -1) return

  let nextIdx = -1
  if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % tabs.length
  else if (e.key === 'ArrowLeft') nextIdx = (currentIdx - 1 + tabs.length) % tabs.length
  else if (e.key === 'Home') nextIdx = 0
  else if (e.key === 'End') nextIdx = tabs.length - 1
  else return

  e.preventDefault()
  activateTab(tabs[nextIdx], true)
  tabs[nextIdx].focus()
})

/** Wire all synced strips: apply stored choice on load and subscribe to changes. */
function initSyncedTabs() {
  const urlParams = new URLSearchParams(location.search)

  document.querySelectorAll('[data-sync-key]').forEach(list => {
    const syncKey = (list as HTMLElement).dataset.syncKey!
    const container = list.closest('[data-component="tabs"]')
    if (!container) return

    // Collect available values for this strip (needed for resolveChoice firstTab)
    const availableBtns = list.querySelectorAll<HTMLElement>('[role="tab"][data-sync-value]')
    const values = Array.from(availableBtns).map(b => b.dataset.syncValue ?? '').filter(Boolean)

    // Resolve with URL param taking priority over stored choice
    const urlValue = urlParams.get(syncKey) ?? undefined
    const choice = resolveChoice(syncKey, {
      urlParam: urlValue,
      stored: getChoice(syncKey) || undefined,
      firstTab: values[0],
    })

    if (choice) {
      applyChoiceToStrip(container, choice)
      // Persist the URL-driven choice so sibling strips on the same page pick it up
      if (urlValue) setChoice(syncKey, choice)
    }

    // Subscribe: when any strip (same page or another tab) writes the same key, follow
    onChange(syncKey, (value) => applyChoiceToStrip(container, value))
  })
}

// --- API Helper ---
const CAP_BASE = document.documentElement.dataset.capBase || ''
const _apiBase = document.documentElement.dataset.apiBase || '/api'
const API_BASE = _apiBase.startsWith('http') ? _apiBase : CAP_BASE + _apiBase

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { credentials: 'include' })
    return res.ok ? res.json() : null
  } catch { return null }
}

async function apiPost(path: string, body?: unknown): Promise<boolean> {
  try {
    // csrfFetch attaches the AppRouter CSRF token (x-csrf-token handshake via
    // GET /auth/user) required for mutating POSTs on the XSUAA-protected
    // /api/(.*) route. A plain fetch() here 403s — this is the completeStep
    // regression (issue #895 re-enabled CSRF but this main-page path was
    // missed; only the tutorial-pip island was migrated to csrfFetch).
    const res = await csrfFetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return res.ok
  } catch { return false }
}

// U14: flip data-hydrated on the documentElement once the progress fetch is
// settled (or after a 1.5s race timeout). Idempotent — the head.html tail
// fallback may have already done this; setting the same value is a no-op.
function markHydrated() {
  if (document.documentElement.dataset.hydrated === 'false') {
    document.documentElement.dataset.hydrated = 'true';
  }
}

// --- Progress tracking ---
function markButtonCompleted(btn: HTMLButtonElement) {
  btn.textContent = 'Completed'
  btn.disabled = true
  btn.classList.add('is-completed')
}

// U10: shared toast for step-completion feedback. Single instance lives in baseof.html.
type Ui5Toast = HTMLElement & { duration: number; show?: () => void }
function showStepToast(text: string, durationMs: number) {
  const toast = document.getElementById('step-toast') as Ui5Toast | null
  if (!toast) return
  toast.textContent = text
  toast.duration = durationMs
  // ui5-toast.show() is the upgraded-element API. On the first interaction the
  // esbuild bundle may not yet have registered the element — fall back to
  // whenDefined so a synthetic-fast-click (or test) doesn't throw.
  if (typeof toast.show === 'function') {
    toast.show()
  } else {
    customElements.whenDefined('ui5-toast').then(() => toast.show?.())
  }
}

// U10: persistent CTA injected once when all steps are complete.
// ui5-toast is text-only by design; the CTA lives inline so the link remains
// reachable after the toast auto-dismisses (~4s).
function showCompletionCta() {
  const stepsRoot = document.querySelector('.tutorial-steps')
  if (!stepsRoot || stepsRoot.querySelector('.tutorial-completion-cta')) return
  const strip = document.createElement('ui5-message-strip')
  strip.setAttribute('design', 'Positive')
  strip.className = 'tutorial-completion-cta'
  strip.appendChild(document.createTextNode('You’ve finished this tutorial. '))
  const link = document.createElement('a')
  link.href = '/'
  link.textContent = 'Browse more tutorials →'
  strip.appendChild(link)
  stepsRoot.appendChild(strip)
}

async function markDone(btn: HTMLButtonElement) {
  const stepNum = btn.dataset.step
  if (!stepNum || btn.disabled) return
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  // Belt-and-suspenders for the code-check hard gate. The button's `disabled`
  // state is the primary defence (set by initCodeCheckDoneGate), but a stale
  // event handler or a console-driven click could slip through. Re-check the
  // gate class right before we POST so we never persist a "done" for a step
  // whose code-check the reader has not passed.
  if (btn.classList.contains('is-codecheck-gated')) return

  btn.disabled = true
  btn.textContent = 'Saving...'
  const ok = await apiPost(`/completeStep`, { slug, stepNumber: parseInt(stepNum, 10) })

  const step = btn.closest('.tutorial-step')
  if (ok && step) {
    step.classList.add('completed')
    const circle = step.querySelector('.step-check-circle')
    if (circle) circle.textContent = '✓'
    const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
    if (tocItem) tocItem.classList.add('completed')
    markButtonCompleted(btn)
    document.dispatchEvent(new CustomEvent('tutorial:step-completed', {
      detail: { stepIndex: parseInt(stepNum, 10) }
    }))
    updateProgressBar()
    updateRemainingTime()

    // U10: completion feedback. Final-step toast wins over the per-step toast.
    // [tutorial-step-pacing] "complete" + remaining-count both use the
    // required (non-optional) denominator — see requiredStepCounts().
    const { total, completed } = requiredStepCounts()
    if (total > 0 && completed >= total) {
      showStepToast('🎉 Tutorial complete!', 4000)
      showCompletionCta()
    } else {
      const remaining = total - completed
      const tail = remaining === 1 ? '1 to go!' : `${remaining} to go!`
      showStepToast(`Step ${stepNum} complete — ${tail}`, 3000)
    }
  } else {
    btn.textContent = 'Done'
    btn.disabled = false
  }
}

// [tutorial-step-pacing] Optional-step Skip control — client-side UI state
// only (design D3): no completion record is written, so the server's
// authoritative completion calc is untouched (it already excludes optional
// steps from its denominator). Collapses the step and removes it from the
// remaining-time estimate.
function skipStep(btn: HTMLButtonElement) {
  const step = btn.closest('.tutorial-step') as HTMLElement | null
  if (!step) return
  step.classList.add('skipped')
  const body = step.querySelector('.step-body') as HTMLElement | null
  if (body) body.hidden = true
  const icon = step.querySelector('.step-toggle-icon')
  if (icon) icon.textContent = '+'
  btn.disabled = true
  btn.textContent = 'Skipped'
  updateActiveTocItem()
  updateRemainingTime()
}

// --- Remaining-time indicator ("≈ N min left") ---
// Spec: "Step time display" — shown when at least half of the steps declare
// a time, computed from incomplete, non-optional (and non-skipped) steps
// that have a time. Reads each step's `data-time-seconds` (tutorial-step.html
// shortcode) rather than re-parsing #tutorial-data, so it stays in sync with
// whatever the shortcode actually rendered.
function updateRemainingTime() {
  const el = document.getElementById('remaining-time')
  if (!el) return
  const steps = Array.from(document.querySelectorAll<HTMLElement>('.tutorial-step'))
  if (steps.length === 0) { el.hidden = true; return }

  const withTime = steps.filter(s => s.dataset.timeSeconds !== undefined)
  if (withTime.length * 2 < steps.length) { el.hidden = true; return }

  const remainingSeconds = steps
    .filter(s => !s.classList.contains('completed') && !s.classList.contains('skipped'))
    .filter(s => s.dataset.optional !== 'true')
    .reduce((sum, s) => sum + (parseInt(s.dataset.timeSeconds || '0', 10) || 0), 0)

  if (remainingSeconds <= 0) { el.hidden = true; return }
  const minutes = Math.max(1, Math.round(remainingSeconds / 60))
  el.hidden = false
  el.textContent = `≈ ${minutes} min left`
}

function initProgressBar() {
  const container = document.getElementById('progress-bar')
  if (!container) return
  const count = parseInt(container.dataset.stepCount || '0', 10)
  if (count === 0) return

  const bar = document.createElement('div')
  bar.className = 'progress-segments'
  for (let i = 1; i <= count; i++) {
    const seg = document.createElement('div')
    seg.className = 'progress-segment'
    seg.dataset.step = String(i)
    bar.appendChild(seg)
  }
  container.appendChild(bar)

  const label = document.createElement('div')
  label.className = 'progress-label'
  label.textContent = `0 / ${count}`
  container.appendChild(label)
}

// [tutorial-step-pacing] Tutorial completion requires only non-optional
// (`data-optional` absent) steps — mirrors the server-side denominator in
// srv/developer-service.js's _updateTutorialProgress. Recomputed from the
// DOM rather than threaded through every caller so there is exactly one
// source of truth for "is this tutorial actually complete" on the client.
function requiredStepCounts(): { completed: number; total: number } {
  const requiredSteps = Array.from(document.querySelectorAll<HTMLElement>('.tutorial-step'))
    .filter(s => s.dataset.optional !== 'true')
  const completed = requiredSteps.filter(s => s.classList.contains('completed')).length
  return { completed, total: requiredSteps.length }
}

function updateProgressBar() {
  const completed = document.querySelectorAll('.tutorial-step.completed').length
  const total = document.querySelectorAll('.tutorial-step').length

  document.querySelectorAll('.progress-segment').forEach(seg => {
    const el = seg as HTMLElement
    const step = parseInt(el.dataset.step || '0', 10)
    el.classList.toggle('completed', step <= completed)
  })

  const label = document.querySelector('.progress-label')
  if (label) label.textContent = `${completed} / ${total}`

  const required = requiredStepCounts()
  if (required.total > 0 && required.completed >= required.total) maybeShowCompletedBanner()
}

async function loadProgress() {
  const slug = document.querySelector('#progress-bar')?.getAttribute('data-slug')
  if (!slug) return

  const data = await apiGet<{ completedSteps: number[] }>(`/getProgress(slug='${encodeURIComponent(slug)}')`)
  if (!data?.completedSteps) return

  for (const stepNum of data.completedSteps) {
    const step = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`)
    if (step) {
      step.classList.add('completed')
      const circle = step.querySelector('.step-check-circle')
      if (circle) circle.textContent = '✓'
      const tocItem = document.querySelector(`.step-toc-item[data-toc-step="${stepNum}"]`)
      if (tocItem) tocItem.classList.add('completed')
      const btn = step.querySelector('[data-action="mark-done"]') as HTMLButtonElement | null
      if (btn) markButtonCompleted(btn)
    }
  }
  updateProgressBar()
  updateRemainingTime()
  maybeShowCompletedBanner()
}

function maybeShowCompletedBanner() {
  const { completed, total } = requiredStepCounts()
  if (!total || completed < total) return
  const host = document.querySelector('.tutorial-banners')
  if (!host || host.querySelector('[data-banner="completed"]')) return
  const strip = document.createElement('ui5-message-strip')
  strip.setAttribute('design', 'Positive')
  strip.setAttribute('data-banner', 'completed')
  strip.textContent = 'You completed this tutorial. Nice work!'
  host.appendChild(strip)
}

// --- Auth-aware button state ---
function initAuthAwareButtons() {
  const observer = new MutationObserver(() => {
    if (document.documentElement.dataset.authenticated === 'true') {
      enableDoneButtons()
      observer.disconnect()
    }
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-authenticated'] })

  // If auth check completes before this runs
  if (document.documentElement.dataset.authenticated === 'true') {
    observer.disconnect()
    return
  }

  // Disable after a short delay to allow auth check to complete first
  setTimeout(() => {
    if (document.documentElement.dataset.authenticated !== 'true') {
      disableDoneButtons()
    }
  }, 1000)
}

function disableDoneButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="mark-done"]').forEach(btn => {
    if (btn.closest('.tutorial-step')?.querySelector('[data-validated="false"]')) return
    btn.disabled = true
    btn.title = 'Sign in to track your progress'
    btn.classList.add('is-auth-disabled')
  })
}

function enableDoneButtons() {
  document.querySelectorAll<HTMLButtonElement>('[data-action="mark-done"].is-auth-disabled').forEach(btn => {
    btn.disabled = false
    btn.title = ''
    btn.classList.remove('is-auth-disabled')
  })
}

// --- Done-button validation gate ---
// Read tutorial-data, find steps with validation, disable their Done buttons.
// Listen for 'step-validated' events from the validation Vue island
// (hugo-apps/src/validation) to re-enable the button when validation passes.
// NOTE: This function is NEW in the Task 3 commit and must survive Task 4's
// legacy delete (which removes initValidation/renderQuiz/handleQuizSubmit).
function initDoneButtonGate() {
  const dataEl = document.getElementById('tutorial-data')
  if (!dataEl) return
  let steps: Array<{ number: number; validation?: unknown[] }>
  try {
    let parsed = JSON.parse(dataEl.textContent || '[]')
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    steps = parsed
  } catch { return }

  const validatedSteps = new Set<number>()
  for (const step of steps) {
    if (!step.validation?.length) continue
    validatedSteps.add(step.number)
    const doneBtn = document.querySelector(
      `button[data-action="mark-done"][data-step="${step.number}"]`
    ) as HTMLButtonElement | null
    if (doneBtn) doneBtn.disabled = true
  }

  // Persisted-correct restore: the Vue island (validation.js, deferred module)
  // runs in document order BEFORE DOMContentLoaded, so its onMounted dispatch of
  // 'step-validated' fires before this listener is attached. However the island
  // also sets data-validated="true" on the step element synchronously in
  // onMounted — that attribute IS in the DOM when DOMContentLoaded runs.
  // Read it here to re-enable Done buttons for already-correct steps so
  // returning learners are not left with a permanently-disabled Done button.
  for (const stepNum of validatedSteps) {
    const stepEl = document.querySelector(`.tutorial-step[data-step="${stepNum}"]`)
    if (stepEl?.getAttribute('data-validated') === 'true') {
      const btn = document.querySelector(
        `button[data-action="mark-done"][data-step="${stepNum}"]`
      ) as HTMLButtonElement | null
      if (btn) btn.disabled = false
    }
  }

  document.addEventListener('step-validated', (e) => {
    const stepNum = (e as CustomEvent<{ stepNumber: number }>).detail?.stepNumber
    if (typeof stepNum !== 'number' || !validatedSteps.has(stepNum)) return
    const doneBtn = document.querySelector(
      `button[data-action="mark-done"][data-step="${stepNum}"]`
    ) as HTMLButtonElement | null
    if (doneBtn) doneBtn.disabled = false
  })
}

// --- Done-button code-check gate (hard gate, issue surfaced 2026-06-23) ---
// Steps that opted into AI code-check (rendered via codecheck-mount.html) get
// their Done button disabled until the reader posts a submission and the
// grader returns verdict === 'pass'. Mirrors initDoneButtonGate() above but
// uses the rendered `.step-codecheck-mount` div as the per-step signal (no
// reliance on tutorial-data) and the `tutorial:codecheck-verdict` event
// dispatched by hugo-apps/src/code-check/CodeCheck.vue on every submission.
function initCodeCheckDoneGate() {
  const mounts = document.querySelectorAll<HTMLElement>('.step-codecheck-mount')
  if (mounts.length === 0) return

  const gatedSteps = new Set<number>()
  for (const mount of mounts) {
    const stepNum = parseInt(mount.dataset.step || '0', 10)
    if (!stepNum) continue
    gatedSteps.add(stepNum)
    const doneBtn = document.querySelector(
      `button[data-action="mark-done"][data-step="${stepNum}"]`
    ) as HTMLButtonElement | null
    if (doneBtn) {
      doneBtn.disabled = true
      doneBtn.title = 'Pass the code-check to mark this step done'
      doneBtn.classList.add('is-codecheck-gated')
    }
  }

  document.addEventListener('tutorial:codecheck-verdict', (e) => {
    const detail = (e as CustomEvent<{ stepNumber: number; verdict: string }>).detail
    if (!detail || typeof detail.stepNumber !== 'number') return
    if (!gatedSteps.has(detail.stepNumber)) return
    if (detail.verdict !== 'pass') return
    const doneBtn = document.querySelector(
      `button[data-action="mark-done"][data-step="${detail.stepNumber}"]`
    ) as HTMLButtonElement | null
    if (doneBtn) {
      doneBtn.disabled = false
      doneBtn.title = ''
      doneBtn.classList.remove('is-codecheck-gated')
    }
  })
}

// --- Print / Save-as-PDF (#1943) ---
// Every tutorial <img> is rendered loading="lazy" (render-image.html). Browsers
// do NOT force off-screen lazy images to load before printing, and images that
// never entered the viewport never fire `load` — so calling window.print()
// directly leaves most step images blank in the printed output (#1943 bug).
// Before printing we flip every not-yet-loaded lazy image to eager so the fetch
// kicks off (an eager <img> loads even inside a display:none/hidden step body,
// which the collapsed steps are on screen), then await them all with a hard
// timeout so a slow/broken image (broken source refs 404 on GitHub) can't wedge
// the print dialog forever.
function preparePrintImages(timeoutMs = 5000): Promise<void> {
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.op-page img'))
  const pending: Promise<void>[] = []
  for (const img of imgs) {
    // Flip lazy → eager to trigger the fetch for images the reader never
    // scrolled to. Assigning `loading` re-evaluates the load for a not-yet
    // loaded lazy image in Chrome/Firefox.
    if (img.loading === 'lazy') img.loading = 'eager'
    if (img.complete && img.naturalWidth > 0) continue
    pending.push(new Promise<void>((resolve) => {
      const done = () => {
        img.removeEventListener('load', done)
        img.removeEventListener('error', done)
        resolve()
      }
      img.addEventListener('load', done, { once: true })
      // Resolve (don't reject) on error so a broken image never blocks print.
      img.addEventListener('error', done, { once: true })
    }))
  }
  if (pending.length === 0) return Promise.resolve()
  return Promise.race([
    Promise.all(pending).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

async function printTutorial(): Promise<void> {
  // Activate every deferred video embed first: print.css expands all steps, but
  // a still-collapsed step's iframe carries only data-src, so it would print
  // blank. activateLazyEmbeds is idempotent and cheap on already-live iframes.
  activateLazyEmbeds(document)
  await preparePrintImages()
  window.print()
}

// --- Printable deep link (?print=1) ---
// Opens the browser print dialog once the page has fully loaded (images/fonts
// settled) so a shared /tutorials/<slug>/?print=1 link lands the reader
// straight in Print / Save-as-PDF. print.css (media="print") forces the light
// theme and expands all collapsed steps, so no on-screen expansion is needed.
// printTutorial() force-loads lazy images first (see above) so the printed page
// isn't missing its below-the-fold screenshots.
function initPrintDeepLink() {
  if (!new URLSearchParams(location.search).has('print')) return
  const fire = () => { void printTutorial() }
  if (document.readyState === 'complete') {
    setTimeout(fire, 300)
  } else {
    window.addEventListener('load', () => setTimeout(fire, 300), { once: true })
  }
}

// --- Init on DOMContentLoaded ---
document.addEventListener('DOMContentLoaded', () => {
  initProgressBar()
  updateRemainingTime()
  // U14: race the real fetch against a 1.5s timeout so a slow or 401 response
  // does not strand users on shimmer. Both branches call markHydrated();
  // markHydrated() is idempotent.
  Promise.race([
    loadProgress().then(markHydrated, markHydrated),
    new Promise<void>((resolve) => setTimeout(() => { markHydrated(); resolve() }, 1500)),
  ])
  initDoneButtonGate()
  initCodeCheckDoneGate()
  initSyncedTabs()
  updateActiveTocItem()
  initAuthAwareButtons()
  initStepHashNavigation()
  initPrintDeepLink()
  initMermaid()
  initTableEnhance()
  // Activate embeds in any step that is open on load (step 1 is expanded by
  // default) so its video sizes correctly and gets a full-res poster.
  document.querySelectorAll<HTMLElement>('.tutorial-step .step-body:not([hidden])')
    .forEach(activateLazyEmbeds)
})
