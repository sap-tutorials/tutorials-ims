// Homepage Devtoberfest banner island (#2131).
//
// Vanilla hydrator (mirrors topic-clusters-band): fetches the public event
// window from /api/devtoberfest/status, then renders a live countdown before
// the event and a "live now" + date range during it. The phase/label logic is
// the pure bannerView() in ./view.ts; this file only owns the fetch, the DOM,
// and the once-a-second tick. When there is no active/upcoming event (503,
// ended, error) the SSR shell stays hidden — no layout shift, no crash.

import { bannerView } from './view'
import type { StatusResponse } from '../devtoberfest/types'

const TICK_MS = 1000

function hydrate(root: HTMLElement): void {
  const api = root.dataset.api || '/api/devtoberfest/status'
  const href = root.dataset.href || '/devtoberfest/'
  const msgEl = root.querySelector<HTMLElement>('[data-role="msg"]')
  const winEl = root.querySelector<HTMLElement>('[data-role="window"]')
  const linkEl = root.querySelector<HTMLAnchorElement>('a.hp-dtf-banner__link')
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

  const render = (status: StatusResponse | null): void => {
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
    .then((r) => (r.ok ? (r.json() as Promise<StatusResponse>) : null))
    .then((status) => {
      render(status)
      // Only tick while something is visible; render() self-hides once the
      // window closes (crossing endDate), clearing the interval then.
      if (!root.hidden) {
        timer = setInterval(() => render(status), TICK_MS)
      }
    })
    .catch(() => hide())
}

document
  .querySelectorAll<HTMLElement>('[data-app="devtoberfest-banner"]')
  .forEach(hydrate)
