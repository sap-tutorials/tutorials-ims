#!/usr/bin/env node
/**
 * scripts/lib/extract-hana-creds.cjs
 *
 * Parse a `cf env <app>` text dump and emit the app's SOURCE HANA
 * credentials as the compact JSON shape the migrators expect
 * ({host, port, user, password, schema}). Local file transform only — does
 * NOT call cf and never prints secret values.
 *
 * Credential preference (IMPORTANT):
 *   1. User-provided DB_URL + DB_USERNAME + DB_PASSWORD env vars. This is
 *      what the legacy IMS Java app actually connects with (schema=IMSDBUSER)
 *      and what the last full migration used (migration log: user=IMSDBUSER
 *      schema=IMSDBUSER). The real IMS_* tables live in this schema.
 *   2. Fallback: the `hana` HDI-container service binding. NOTE this is the
 *      DESIGN-TIME container (a different, empty schema with a _DT user) — it
 *      canNOT read the IMS_* tables. Only used if the DB_* vars are absent,
 *      and flagged loudly so the operator notices.
 *
 * Usage:
 *   node scripts/lib/extract-hana-creds.cjs <cf-env-dump.txt> <out.json>
 *
 * Prints only non-secret fields (host prefix, port, schema, user suffix) plus
 * a "password set: true/false" so the operator can sanity-check the parse
 * without the password reaching stdout / the transcript.
 */
'use strict';

const fs = require('node:fs');

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error('Usage: node scripts/lib/extract-hana-creds.cjs <cf-env-dump.txt> <out.json>');
  process.exit(2);
}

const raw = fs.readFileSync(inPath, 'utf8');

// ── Preferred path: user-provided DB_URL/DB_USERNAME/DB_PASSWORD env vars.
// `cf env` renders these as `KEY: value` lines (VCAP_APPLICATION /
// user-provided section). Extract each; parse host/port/schema out of the
// JDBC URL (jdbc:sap://host:port/?currentschema=IMSDBUSER&...).
function envVal(key) {
  // Match `"KEY": "value"` (JSON) or `KEY: value` (YAML-ish) forms.
  const jsonRe = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`);
  const yamlRe = new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*(\\S[^\\n]*)`);
  const j = raw.match(jsonRe);
  if (j) return j[1];
  const y = raw.match(yamlRe);
  if (y) return y[1].trim().replace(/^"|"$/g, '');
  return null;
}

function fromDbEnvVars() {
  const url = envVal('DB_URL');
  const user = envVal('DB_USERNAME') || envVal('DB_USER');
  const password = envVal('DB_PASSWORD');
  if (!url || !user || !password) return null;
  // jdbc:sap://<host>:<port>/?currentschema=<schema>&encrypt=true...
  const u = new URL(url.replace(/^jdbc:sap:\/\//, 'https://'));
  const schema = u.searchParams.get('currentschema') || user;
  return {
    host: u.hostname,
    port: u.port || '443',
    user,
    password,
    schema,
    _source: 'DB_* env vars',
  };
}

function fromHdiBinding() {
  const marker = raw.indexOf('VCAP_SERVICES');
  if (marker < 0) return null;
  const start = raw.indexOf('{', marker);
  let depth = 0, end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return null;
  const vcap = JSON.parse(raw.slice(start, end + 1));
  const binding = (vcap.hana || []).find((s) => s.credentials && s.credentials.host);
  if (!binding) return null;
  const c = binding.credentials;
  return {
    host: c.host,
    port: c.port,
    user: c.hdi_user || c.user,
    password: c.hdi_password || c.password,
    schema: c.schema,
    _source: 'hana HDI binding (DESIGN-TIME — likely cannot read IMS_* tables)',
  };
}

const dbVars = fromDbEnvVars();
const out = dbVars || fromHdiBinding();
if (!out) {
  console.error('Could not resolve source creds: no DB_* env vars and no hana binding with host.');
  process.exit(1);
}

const source = out._source;
delete out._source;
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log(`Wrote ${outPath}  (from: ${source})`);
console.log(`  host:   ${(out.host || '').slice(0, 32)}...`);
console.log(`  port:   ${out.port}`);
console.log(`  schema: ${out.schema}`);
console.log(`  user:   ${out.user}`);
console.log(`  password set: ${Boolean(out.password)}`);
if (!dbVars) {
  console.warn('\n  ⚠ Fell back to the HDI binding. This is the design-time container schema,');
  console.warn('    which does NOT contain the IMS_* source tables. Verify DB_URL/DB_USERNAME/');
  console.warn('    DB_PASSWORD exist in the cf env dump before running the migration.');
}
