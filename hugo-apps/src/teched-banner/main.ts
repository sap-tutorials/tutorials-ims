// Homepage SAP TechEd banner island (#2751).
//
// Vanilla hydrator (mirrors devtoberfest-banner/main.ts): fetches the fixed
// production event window from /api/teched/event-status, then renders a live
// countdown before the event, a "live now" message during it, and a persistent
// "watch the replays" strip after it ends. The phase/label logic is the pure
// bannerView() in ./view.ts; this file only owns the fetch, the DOM, and the
// once-a-second tick. Only an absent/unparseable window keeps the SSR shell
// hidden — in that case there is no layout shift.

import { bannerView } from './view'
import type { TechEdStatusResponse } from './view'

const TICK_MS = 1000

function hydrate(root: HTMLElement): void {
  const api = root.dataset.api || '/api/teched/event-status'
  const href = root.dataset.href || '/teched/'
  const msgEl = root.querySelector<HTMLElement>('[data-role="msg"]')
  const winEl = root.querySelector<HTMLElement>('[data-role="window"]')
  const linkEl = root.querySelector<HTMLAnchorElement>('a.hp-te-banner__link')
  if (!msgEl || !winEl || !linkEl) return

  linkEl.href = href

  let timer: ReturnType<typeof setInterval> | undefined

  const hide = (): void => {
    root.hidden = true
    root.setAttribute('aria-hidden', 'true')
    if (timer) {
      clearInterval(timer)
      timer = undefined
    }
  }

  const render = (status: TechEdStatusResponse | null): void => {
    const v = bannerView(status, Date.now())
    if (!v.show) {
      hide()
      return
    }
    msgEl.textContent = v.message
    winEl.textContent = v.window
    root.dataset.phase = v.phase
    root.hidden = false
    root.setAttribute('aria-hidden', 'false')
  }

  fetch(api, { headers: { Accept: 'application/json' } })
    .then((r) => (r.ok ? (r.json() as Promise<TechEdStatusResponse>) : null))
    .then((status) => {
      render(status)
      // Only tick while something is visible. Unlike Devtoberfest the banner
      // stays up after the event (the 'after' phase shows "watch the replays"),
      // so the tick keeps the countdown fresh up to the start/during crossings
      // and then settles on a static replay message — render() self-hides only
      // when the window is absent/unparseable.
      if (!root.hidden) {
        timer = setInterval(() => render(status), TICK_MS)
      }
    })
    .catch(() => hide())
}

document
  .querySelectorAll<HTMLElement>('[data-app="teched-banner"]')
  .forEach(hydrate)
