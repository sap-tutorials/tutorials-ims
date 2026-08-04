import xsenv from '@sap/xsenv';

function readConfig() {
  let endpoint = null;
  try {
    xsenv.loadEnv();
    const creds = xsenv.serviceCredentials({ label: 'cloud-logging' });
    endpoint = creds?.['dashboards-endpoint'] || null;
  } catch {
    endpoint = null;
  }

  let appName = null;
  if (process.env.VCAP_APPLICATION) {
    try {
      appName = JSON.parse(process.env.VCAP_APPLICATION).application_name || null;
    } catch {
      appName = null;
    }
  }

  return endpoint && appName ? { endpoint, appName } : null;
}

export function resetConfigCache() {
  // No-op kept for backward compatibility with tests that toggle VCAP_* across cases.
}

const PRE_PADDING_MS = 10_000;
const POST_PADDING_MS = 30_000;

// SAP Cloud Logging ingests CF-runtime app stdout/stderr (the "raw app stdout"
// this link surfaces) into the `logs-cfsyslog-*` index. In that index the CF app
// name is stored in the `app_name` field (NOT `cf_app_name` — that field does not
// exist in the cfsyslog mapping). OTLP-exported telemetry (@cap-js/telemetry) lands
// in a SEPARATE `logs-otel-v1-*` index keyed by `serviceName`. The Discover deep-link
// MUST pin the cfsyslog index pattern, or it queries whatever data view is
// default/last-selected (typically the OTLP index) and returns "No Results".
//
// This ID is a stable SAP-managed content-package index-pattern ID (shipped by the
// `perfx` content package on every cloud-logging/standard instance), NOT a
// per-instance saved-object UUID — so it is portable across DEV/QA/PROD.
//
// The queried value comes from VCAP_APPLICATION.application_name, which loggregator
// stamps into `app_name` on every line — so they match by construction, including
// PROD's blue-green `-live` suffix (`tutorials-srv-live`). No env-specific hardcoding.
const CFSYSLOG_INDEX_PATTERN = 'maintained-by-perfx_cf-content-package_index-pattern-logs-cfsyslog';

export function buildCfLogsUrl({ startedAt, finishedAt } = {}) {
  if (!startedAt) return null;
  const config = readConfig();
  if (!config) return null;

  const startMs = new Date(startedAt).getTime();
  if (Number.isNaN(startMs)) return null;
  const endMs = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (Number.isNaN(endMs)) return null;

  const fromISO = new Date(startMs - PRE_PADDING_MS).toISOString();
  const toISO   = new Date(endMs + POST_PADDING_MS).toISOString();

  // Rison state for the Data Explorer Discover app, split across three params:
  //   _a  app state — pins the cfsyslog index pattern (the load-bearing fix)
  //   _g  global state — the time window around the run
  //   _q  query state — the kuery filtering to this CF app
  const a = `(discover:(columns:!(_source),isDirty:!f,sort:!()),metadata:(indexPattern:${CFSYSLOG_INDEX_PATTERN},view:discover))`;
  const g = `(filters:!(),refreshInterval:(pause:!t,value:0),time:(from:'${fromISO}',to:'${toISO}'))`;
  const q = `(filters:!(),query:(language:kuery,query:'app_name : "${config.appName}"'))`;
  return `https://${config.endpoint}/app/data-explorer/discover#?_a=${encodeURIComponent(a)}&_g=${encodeURIComponent(g)}&_q=${encodeURIComponent(q)}`;
}
