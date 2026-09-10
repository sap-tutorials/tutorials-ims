// Site-wide "Copy code" handler.
//
// render-codeblock.html emits `<button class="code-block-copy"
// onclick="copyCodeBlock(this)">` on EVERY fenced code block across the site,
// not just tutorial pages. The definition used to live only in tutorial.ts
// (loaded on tutorial layouts alone), so the inline onclick threw
// "copyCodeBlock is not defined" on any other page carrying a code block —
// e.g. /api-docs/graphql/ (issue #2226).
//
// This module defines window.copyCodeBlock unconditionally and is loaded on
// every page from baseof.html, so the button works everywhere it renders.
import { stripPrompts } from './copy-clean'

;(window as any).copyCodeBlock = function (btn: HTMLButtonElement) {
  const block = btn.closest('.code-block')
  if (!block) return
  const code = block.querySelector('.code-block-body code, .code-block-body pre')
  if (!code) return
  let text = code.textContent || ''
  // copy-clean is a tutorial reading pref; harmless elsewhere (strips only a
  // single leading shell/REPL prompt per line).
  try { if (localStorage.getItem('tut.pref.copyClean') === 'on') text = stripPrompts(text) } catch {}
  navigator.clipboard.writeText(text).then(() => {
    const label = btn.querySelector('.copy-label')
    if (label) {
      label.textContent = 'Copied!'
      setTimeout(() => { label.textContent = 'Copy' }, 2000)
    }
  })
}
