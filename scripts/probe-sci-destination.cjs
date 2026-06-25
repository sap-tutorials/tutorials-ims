/* eslint-disable no-console */
/**
 * Probe SCI / SAP ID Service destination connectivity from `tutorial-system` subaccount.
 *
 * Companion to scripts/backfill-user-profiles.cjs (issue #632).
 *
 * What this proves / disproves:
 *   - Whether credentials in BTP destination `SCI_prod` (or `SCI`) are working.
 *   - Whether the legacy `/cps/user/{sapId}.json` endpoint (IMS Java pattern)
 *     returns the expected `{user: {mail, firstName, lastName, displayName}}` shape.
 *   - Whether SCIM endpoints (`/scim/Users`, `/scim/ServiceProviderConfig`,
 *     `/scim/Me`) are reachable from this service account.
 *
 * Known states observed during #632 investigation (2026-06-25):
 *   - Initial probe: 403 on everything → diagnosed as redacted password from
 *     cockpit export/import.
 *   - After password re-paste: 200 on `/cps/user/{sapId}.json` with full payload.
 *   - After ~10 concurrent probe calls: 403 again on every endpoint, including
 *     for sapIds that worked moments before. SUSPECTED RATE LIMITING by SCI.
 *
 * If you see 403s here, possible causes (in order of likelihood):
 *   1. Rate-limit cooldown — wait 30-60 min, re-probe at 1 req/min.
 *   2. Destination password drifted / vault rotated — re-verify in cockpit.
 *   3. Service-account role removed on the SCI tenant — contact SCI / Customer
 *      Identity team for `tutorial-system` subaccount.
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/probe-sci-destination.cjs
 *   npx cds bind --exec -- node scripts/probe-sci-destination.cjs P1941183212
 *   npx cds bind --exec -- node scripts/probe-sci-destination.cjs P1941183212 SCI_prod
 */
const { getDestination } = require('@sap-cloud-sdk/connectivity');

async function probeDestination(destName, sapId) {
  const d = await getDestination({ destinationName: destName });
  if (!d) {
    console.log(`destination "${destName}" not visible to this subaccount`);
    return;
  }
  const auth = 'Basic ' + Buffer.from(`${d.username}:${d.password}`).toString('base64');
  const url = d.url;
  console.log(`\n=== ${destName} (${url}, user=${d.username}, pwdLen=${d.password?.length || 0}) ===`);

  const tries = [
    { label: 'Legacy CPS endpoint',                    path: `/cps/user/${encodeURIComponent(sapId)}.json` },
    { label: 'SCIM ServiceProviderConfig (open)',      path: '/scim/ServiceProviderConfig' },
    { label: 'SCIM Schemas (typically requires auth)', path: '/scim/Schemas' },
    { label: `SCIM own profile (SA)`,                  path: `/scim/Users/${encodeURIComponent(d.username)}` },
    { label: `SCIM read target by id`,                 path: `/scim/Users/${encodeURIComponent(sapId)}` },
    { label: `SCIM filter by externalId`,              path: `/scim/Users?filter=${encodeURIComponent(`externalId eq "${sapId}"`)}` },
    { label: `SCIM filter by userName`,                path: `/scim/Users?filter=${encodeURIComponent(`userName eq "${sapId}"`)}` },
  ];
  for (const t of tries) {
    const r = await fetch(`${url}${t.path}`, {
      headers: { 'Authorization': auth, 'Accept': 'application/scim+json' },
    });
    const body = await r.text();
    const summary = body.length < 250 ? body : body.slice(0, 250) + '…';
    console.log(`  [${String(r.status).padEnd(3)}] ${t.label}`);
    console.log(`        path: ${t.path}`);
    console.log(`        body: ${summary.replace(/\n/g, ' ')}`);
  }
}

(async () => {
  const sapId = process.argv[2] || 'P1941183212';
  const onlyDest = process.argv[3];
  const destNames = onlyDest ? [onlyDest] : ['SCI_prod', 'SCI'];
  for (const name of destNames) {
    try {
      await probeDestination(name, sapId);
    } catch (e) {
      console.error(`probe ${name} failed:`, e.message);
    }
  }
  process.exit(0);
})();
