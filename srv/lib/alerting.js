// srv/lib/alerting.js
// Fail-open push-alert helper. Never throws — sits BESIDE existing failure
// signals (metrics/log/PipelineLog), never replaces them. Gating is DB-backed
// and admin-editable: ChatSettings.alertsEnabled via the alert-settings
// resolver (NOT an env var — project rule: tunable behavior lives in the DB,
// toggled live in the admin UI). Default OFF until an admin enables it.
import cds from '@sap/cds'
import { isAlertingEnabled } from './runtime-config/alert-settings.js'

const LOG = cds.log('alerting')
let svcPromise  // memoised connection

// #1503 follow-up: the ANS sink (`@sap-tutorials/cds-alert-notification`)
// delivers via a raw `fetch` with NO client-side timeout. A hung connection to
// ANS (e.g. blocked CF egress) therefore never resolves AND never throws — so
// the try/catch below is powerless against it. Symptom: a `svc.raise()` call
// blocks the worker ~86s until CF drops the socket → 502 Gateway Timeout on the
// admin "Send test alert". This wrapper races every raise against a hard
// deadline so a stuck delivery fails FAST (and clean) instead of hanging.
// Belt-and-braces with the AbortController timeout added plugin-side (v1.0.2).
const RAISE_TIMEOUT_MS = 5000

async function raiseWithTimeout (svc, input, ms = RAISE_TIMEOUT_MS) {
  let timer
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`alert delivery timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    await Promise.race([svc.raise(input), timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function raise (input) {
  try {
    if (!(await isAlertingEnabled())) return
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await raiseWithTimeout(svc, input)
  } catch (e) {
    // Never propagate — alerting must not break the path it watches.
    svcPromise = undefined // allow a later reconnect attempt
    LOG.warn('alert raise failed (swallowed):', e?.message ?? e)
  }
}

// #1469: on-demand, result-returning sibling to raise(). Used ONLY by the
// admin "Send test alert" action so the admin sees whether the alert path
// actually fired. Same fail-open contract (never throws) but returns a
// structured outcome instead of swallowing silently. Reuses the memoised
// svcPromise. Callers must pass a unique resource.resourceName per click so
// the plugin's dedup window (dedupWindowMs) never silently drops the test.
export async function raiseTest (input) {
  try {
    if (!(await isAlertingEnabled())) return { outcome: 'disabled' }
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await raiseWithTimeout(svc, input)
    return { outcome: 'delivered' }
  } catch (e) {
    svcPromise = undefined // allow a later reconnect attempt
    const reason = e?.message ?? String(e)
    const timedOut = /timed out/.test(reason)
    LOG.warn('test alert raise failed:', reason)
    return { outcome: timedOut ? 'timeout' : 'error', reason }
  }
}

// Test-only: reset the memoised connection between cases.
export function _resetForTest () { svcPromise = undefined }
