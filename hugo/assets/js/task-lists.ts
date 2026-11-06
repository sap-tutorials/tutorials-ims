// hugo/assets/js/task-lists.ts
// [tutorial-step-pacing] Interactive checklists — progressive enhancement of
// GFM task-list items (`- [ ] Create a subaccount`) that Goldmark renders as
// disabled `<input type="checkbox">`s inside step content.
//
// Design (openspec/changes/tutorial-step-pacing/design.md, D4):
//   - Enable each task-list checkbox found inside a step's `.step-content`.
//   - Assign a stable ID `slug:step:list:item` + a text hash, so editing an
//     item's wording invalidates its persisted state (a changed hash simply
//     misses in storage — no explicit migration needed).
//   - Persist per-reader, per-tutorial state in
//     `localStorage["tasklist:<slug>"]`.
//   - Render a "x/y" counter per list; announce changes via `aria-live`.
//   - Author-authored `- [x]` items render checked but are NOT counted
//     toward the reader's progress (excluded from both the counter's
//     numerator and denominator).
//   - When every TOGGLEABLE item in a step is checked, emphasise that step's
//     Done button (`.is-checklist-complete`) — never auto-marks it done.
//
// NOTE: importing this module fires its DOMContentLoaded init as a
// side-effect, same pattern as tutorial.ts / os-toggle.ts.

interface TaskListState {
  [itemId: string]: boolean
}

function storageKey(slug: string): string {
  return `tasklist:${slug}`
}

function loadState(slug: string): TaskListState {
  try {
    const raw = localStorage.getItem(storageKey(slug))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveState(slug: string, state: TaskListState) {
  try {
    localStorage.setItem(storageKey(slug), JSON.stringify(state))
  } catch {
    /* private mode / quota — checklist state is a non-critical aid */
  }
}

// Small stable string hash (FNV-1a, 32-bit, hex-encoded) — just needs to
// change when item text changes; no cryptographic requirement.
function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function getTutorialSlug(): string | null {
  return document.querySelector('#progress-bar')?.getAttribute('data-slug') ?? null
}

/** A GFM task-list item is an `<li>` whose first element child is a
 *  checkbox input (goldmark emits `<li><input type="checkbox" disabled> text</li>`,
 *  optionally wrapped in a `<p>` for "loose" lists). */
function findTaskListItems(root: ParentNode): HTMLLIElement[] {
  const items: HTMLLIElement[] = []
  root.querySelectorAll('li').forEach((li) => {
    const checkbox = li.querySelector(':scope > input[type="checkbox"], :scope > p:first-child > input[type="checkbox"]:first-child')
    if (checkbox) items.push(li as HTMLLIElement)
  })
  return items
}

function itemText(li: HTMLLIElement, checkbox: HTMLInputElement): string {
  // Clone + strip the checkbox + any nested <ul>/<ol> (sub-lists) so the hash
  // reflects only this item's own label text.
  const clone = li.cloneNode(true) as HTMLLIElement
  clone.querySelectorAll('input[type="checkbox"], ul, ol').forEach((el) => el.remove())
  void checkbox
  return (clone.textContent || '').trim().replace(/\s+/g, ' ')
}

function announce(liveRegion: HTMLElement, message: string) {
  liveRegion.textContent = message
}

function emphasizeDoneButton(stepEl: Element, emphasize: boolean) {
  const doneBtn = stepEl.querySelector<HTMLButtonElement>('[data-action="mark-done"]')
  if (doneBtn) doneBtn.classList.toggle('is-checklist-complete', emphasize)
}

function enhanceTaskList(
  listEl: HTMLElement,
  items: HTMLLIElement[],
  slug: string,
  stepNum: string,
  listIdx: number,
  state: TaskListState,
) {
  const stepEl = listEl.closest('.tutorial-step')
  if (!stepEl) return

  const counter = document.createElement('div')
  counter.className = 'task-list-counter'
  counter.setAttribute('aria-live', 'polite')
  listEl.insertAdjacentElement('beforebegin', counter)

  // Per-item metadata, resolved once up front: ID, whether it's toggleable
  // (i.e. NOT pre-checked `[x]` by the author).
  const entries = items.map((li, itemIdx) => {
    const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement
    const text = itemText(li, checkbox)
    const id = `${slug}:step-${stepNum}:list-${listIdx}:item-${itemIdx}:${hashText(text)}`
    const preChecked = checkbox.hasAttribute('checked') || checkbox.checked
    return { li, checkbox, id, preChecked }
  })

  function toggleableEntries() {
    return entries.filter((e) => !e.preChecked)
  }

  function refresh() {
    const toggleable = toggleableEntries()
    const checkedCount = toggleable.filter((e) => e.checkbox.checked).length
    counter.textContent = `${checkedCount}/${toggleable.length}`
    const allChecked = toggleable.length > 0 && checkedCount === toggleable.length
    emphasizeDoneButton(stepEl, allChecked)
    return { checkedCount, total: toggleable.length }
  }

  for (const entry of entries) {
    const { li, checkbox, id, preChecked } = entry
    li.classList.add('task-list-item')
    checkbox.classList.add('task-list-checkbox')
    // Stable, visible label association for a11y — goldmark's raw output has
    // no <label>, so screen readers only announce "checkbox" with no name.
    if (!checkbox.id) checkbox.id = `tasklist-${id}`.replace(/[^a-zA-Z0-9_-]/g, '-')
    if (!li.querySelector(`label[for="${checkbox.id}"]`)) {
      const label = document.createElement('label')
      label.setAttribute('for', checkbox.id)
      label.className = 'task-list-item-label'
      // Move the item's existing (text) nodes into the label so the
      // checkbox + its text are a single clickable/announced control.
      while (checkbox.nextSibling) label.appendChild(checkbox.nextSibling)
      li.appendChild(label)
    }

    if (preChecked) {
      checkbox.disabled = true // author-authored `[x]` — not reader-toggleable
      continue
    }

    checkbox.disabled = false
    checkbox.checked = state[id] === true

    checkbox.addEventListener('change', () => {
      state[id] = checkbox.checked
      saveState(slug, state)
      const { checkedCount, total } = refresh()
      announce(counter, `${checkedCount} of ${total} items checked`)
    })
  }

  refresh()
}

function initTaskLists() {
  const slug = getTutorialSlug()
  if (!slug) return
  const state = loadState(slug)

  document.querySelectorAll<HTMLElement>('.tutorial-step .step-content').forEach((content) => {
    const stepEl = content.closest('.tutorial-step')
    const stepNum = stepEl?.getAttribute('data-step') ?? '0'

    // A "task list" is any <ul>/<ol> containing at least one checkbox item,
    // considered at its own nesting level (not a descendant of another list
    // already picked up) so sub-lists get their own counter.
    const seen = new Set<Element>()
    let listIdx = 0
    content.querySelectorAll<HTMLElement>('ul, ol').forEach((listEl) => {
      if ([...seen].some((ancestor) => ancestor.contains(listEl))) return
      const items = findTaskListItems(listEl).filter((li) => li.parentElement === listEl)
      if (items.length === 0) return
      seen.add(listEl)
      enhanceTaskList(listEl, items, slug, stepNum, listIdx, state)
      listIdx++
    })
  })
}

document.addEventListener('DOMContentLoaded', initTaskLists)
