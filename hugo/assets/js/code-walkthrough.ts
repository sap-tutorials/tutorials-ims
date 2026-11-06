// code-walkthrough.ts — activates line-range highlighting for :::walkthrough blocks.

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll<HTMLElement>('[data-walkthrough]').forEach(wt => {
    const codeEl = wt.querySelector<HTMLElement>('.tut-walkthrough-code')
    const notesEl = wt.querySelector<HTMLElement>('.tut-walkthrough-notes')
    if (!codeEl || !notesEl) return

    const noteItems = notesEl.querySelectorAll<HTMLElement>('li')
    noteItems.forEach(note => {
      note.style.cursor = 'pointer'
      note.addEventListener('click', () => {
        codeEl.querySelectorAll('.wt-hl').forEach(el => el.classList.remove('wt-hl'))
        const wasActive = note.classList.contains('wt-active')
        noteItems.forEach(n => n.classList.remove('wt-active'))
        if (wasActive) return
        note.classList.add('wt-active')
        const rangeMatch = note.textContent?.match(/\{(\d+)(?:-(\d+))?\}/)
        if (!rangeMatch) return
        const start = parseInt(rangeMatch[1], 10)
        const end = rangeMatch[2] ? parseInt(rangeMatch[2], 10) : start
        const lines = codeEl.querySelectorAll<HTMLElement>('.line')
        lines.forEach((line, i) => {
          if (i + 1 >= start && i + 1 <= end) {
            line.classList.add('wt-hl')
            if (i + 1 === start) line.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
          }
        })
      })
    })
  })
})
