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

  const g = `(time:(from:'${fromISO}',to:'${toISO}'))`;
  const a = `(query:(language:kuery,query:'cf_app_name : "${config.appName}"'))`;
  return `https://${config.endpoint}/app/discover#/?_g=${encodeURIComponent(g)}&_a=${encodeURIComponent(a)}`;
}
