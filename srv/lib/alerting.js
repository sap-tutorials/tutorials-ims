// srv/lib/alerting.js
// Fail-open push-alert helper. Mirrors metrics.js: namespace import, never throws,
// env kill-switch. Sits BESIDE existing failure signals (metrics/log/PipelineLog),
// never replaces them. Default OFF (ALERTS_ENABLED !== 'true').
import cds from '@sap/cds'

const LOG = cds.log('alerting')
let svcPromise  // memoised connection

function isEnabled () {
  return process.env.ALERTS_ENABLED === 'true'
}

export async function raise (input) {
  if (!isEnabled()) return
  try {
    svcPromise ??= cds.connect.to('alerts')
    const svc = await svcPromise
    await svc.raise(input)
  } catch (e) {
    // Never propagate — alerting must not break the path it watches.
    svcPromise = undefined // allow a later reconnect attempt
    LOG.warn('alert raise failed (swallowed):', e?.message ?? e)
  }
}

// Test-only: reset the memoised connection between cases.
export function _resetForTest () { svcPromise = undefined }
