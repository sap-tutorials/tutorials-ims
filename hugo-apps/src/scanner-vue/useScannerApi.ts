import { ref } from 'vue'
import type { ContestantData, EventStats } from './types'

const toNum = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Coerce the raw getContestant payload so missing/null numerics render 0 (never
// "null of 2") and claimedPrizeNames is always an array.
export function normalizeContestant(raw: Partial<ContestantData> & Record<string, unknown>): ContestantData {
  return {
    uid: String(raw.uid ?? ''),
    eventId: toNum(raw.eventId),
    recordId: String(raw.recordId ?? ''),
    status: String(raw.status ?? ''),
    lastName: String(raw.lastName ?? ''),
    firstInitial: String(raw.firstInitial ?? ''),
    tutorialsCompleted: toNum(raw.tutorialsCompleted),
    groupsCompleted: toNum(raw.groupsCompleted),
    missionsCompleted: toNum(raw.missionsCompleted),
    prizeRecords: String(raw.prizeRecords ?? ''),
    claimedCount: toNum(raw.claimedCount),
    claimedPrizeNames: Array.isArray(raw.claimedPrizeNames) ? raw.claimedPrizeNames.map(String) : [],
  }
}

// claimPrizeForContestant is an OData v4 `action` → POST with params in the body.
// (A function-style GET with params in the URL is not served by an action.)
export function claimRequest(uid: string, eventId: number): { url: string; method: 'POST'; body: { accountNumber: string; eventId: number } } {
  return {
    url: '/scanner/claimPrizeForContestant',
    method: 'POST',
    body: { accountNumber: uid, eventId },
  }
}

// When the XSUAA session expires the AppRouter may answer in one of two ways:
//   1. HTTP 401 on the API call, or
//   2. a 302 → the IdP/login page which `fetch` transparently follows, so the
//      Response lands as `ok` (HTTP 200) carrying an HTML login document with
//      no JSON body (res.redirected === true, content-type text/html).
// The old check only caught case 1, so at TechEd the expired-session scanner
// silently showed a parse error instead of bouncing to login. Detect both:
// reload the page so the AppRouter re-issues its auth redirect from the top.
function redirectToLoginIfUnauthorized(res: Response): boolean {
  const ct = res.headers?.get?.('content-type') ?? ''
  const looksLikeLoginPage = res.redirected || /text\/html/i.test(ct)
  if (res.status === 401 || (res.status === 403 && looksLikeLoginPage) || (res.ok && looksLikeLoginPage)) {
    window.location.reload()
    return true
  }
  return false
}

// The approuter enforces CSRF protection on non-GET requests to /scanner/*
// (that route has no "csrfProtection": false in xs-app.json). The UI5 scanner
// works because sap.ui.model.odata.v4.ODataModel does the fetch-token handshake
// automatically; this Vue port must do it by hand or every claim POST is
// rejected with a bare HTTP 403 (empty body). Fetch a token with a cheap GET
// carrying `x-csrf-token: fetch`, read it off the response header, and attach
// it to the write. Module-scoped cache so repeated claims reuse one token.
let csrfToken: string | null = null

async function fetchCsrfToken(): Promise<string | null> {
  // The OData v4 service document is a cheap GET under the same /scanner/ route
  // and auth scope, so the approuter issues a token for it.
  const res = await fetch('/scanner/', { headers: { 'x-csrf-token': 'fetch' } })
  if (redirectToLoginIfUnauthorized(res)) return null
  const token = res.headers?.get?.('x-csrf-token') ?? null
  if (token && token.toLowerCase() !== 'required') csrfToken = token
  return csrfToken
}

export function useScannerApi() {
  const loading = ref(false)
  const error = ref<string | null>(null)
  const contestant = ref<ContestantData | null>(null)

  async function getContestant(uid: string, eventId: number): Promise<ContestantData> {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/scanner/getContestant(accountNumber='${encodeURIComponent(uid)}',eventId=${eventId})`)
      if (redirectToLoginIfUnauthorized(res)) return Promise.reject(new Error('Session expired'))
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error?.message || `HTTP ${res.status}`)
      }
      const json = await res.json()
      return normalizeContestant(json.value ?? json)
    } finally {
      loading.value = false
    }
  }

  async function getEventStats(eventId: number): Promise<EventStats> {
    const res = await fetch(`/scanner/getEventStats(eventId=${eventId})`)
    if (redirectToLoginIfUnauthorized(res)) return Promise.reject(new Error('Session expired'))
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error?.message || `HTTP ${res.status}`)
    }
    const json = await res.json()
    return json.value ?? json
  }

  async function claimPrizeForContestant(uid: string, eventId: number): Promise<{ claimedCount: number; message: string }> {
    loading.value = true
    error.value = null
    try {
      const { url, method, body } = claimRequest(uid, eventId)

      // POST with a CSRF token, refetching once if the approuter rejects the
      // cached token as stale (403 + "x-csrf-token: Required").
      const postOnce = async (token: string | null): Promise<Response> => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (token) headers['x-csrf-token'] = token
        return fetch(url, { method, headers, body: JSON.stringify(body) })
      }

      let token = await fetchCsrfToken()
      if (token === null && !csrfToken) return Promise.reject(new Error('Session expired'))
      let res = await postOnce(token)

      if (redirectToLoginIfUnauthorized(res)) return Promise.reject(new Error('Session expired'))

      if (res.status === 403 && (res.headers?.get?.('x-csrf-token') ?? '').toLowerCase() === 'required') {
        csrfToken = null
        token = await fetchCsrfToken()
        if (token === null && !csrfToken) return Promise.reject(new Error('Session expired'))
        res = await postOnce(token)
        if (redirectToLoginIfUnauthorized(res)) return Promise.reject(new Error('Session expired'))
      }

      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}))
        throw new Error(errBody.error?.message || `HTTP ${res.status}`)
      }
      const json = await res.json()
      return json.value ?? json
    } finally {
      loading.value = false
    }
  }

  function reset() {
    contestant.value = null
    error.value = null
    loading.value = false
  }

  return { loading, error, contestant, getContestant, getEventStats, claimPrizeForContestant, reset }
}
