// hugo-apps/src/validation/preview-banner.ts
/**
 * [#655] Preview-only banner controller.
 *
 * Wires the Reset button and Reveal-AI-rules toggle to window-level
 * CustomEvents that Validation.vue + PreviewAINotice.vue listen for.
 * Also runs an auto-reset on load to wipe stale __preview__ localStorage
 * keys from prior preview sessions.
 *
 * Loaded by /js/preview-banner.js only when site.Params.previewMode is true.
 */

const PREVIEW_PREFIX = 'tutorial-validation-__preview__-'

function wipePreviewLocalStorage(): void {
  if (typeof localStorage === 'undefined') return
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith(PREVIEW_PREFIX)) toRemove.push(key)
  }
  for (const k of toRemove) localStorage.removeItem(k)
}

function emit(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function wireBanner(): void {
  const resetBtn = document.getElementById('preview-banner-reset')
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      wipePreviewLocalStorage()
      emit('tutorial-preview:reset-answers')
    })
  }
  const revealSwitch = document.getElementById('preview-banner-reveal-ai')
  if (revealSwitch) {
    revealSwitch.addEventListener('change', (ev) => {
      const on = (ev as CustomEvent).detail?.checked === true
      emit('tutorial-preview:reveal-ai-rules', { on })
    })
  }
}

// Auto-reset on load — prevents stale state across edits in the VSCode webview.
wipePreviewLocalStorage()

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireBanner)
} else {
  wireBanner()
}
