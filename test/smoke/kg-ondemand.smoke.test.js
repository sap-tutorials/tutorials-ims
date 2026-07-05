// Post-deploy smoke test. Read-only. Assumes the flag is off in DEV
// unless the operator has flipped it. Two envs:
//   SMOKE_SRV_URL — CAP service base URL (e.g. https://tutorials-srv-dev.cfapps.eu10.hana.ondemand.com)
//   SMOKE_ADMIN_TOKEN — bearer token with Tutorial.Author scope
//
// Run: SMOKE_SRV_URL=... SMOKE_ADMIN_TOKEN=... npx vitest run --project smoke test/smoke/kg-ondemand.smoke.test.js

import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
const TOKEN = process.env.SMOKE_ADMIN_TOKEN;
const RUN = Boolean(SRV);

describe.skipIf(!RUN)('KG on-demand — smoke (#948)', () => {
  it('OData endpoint returns 200 with Tutorial.Author scope', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KgOnDemandRequests?$top=1`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.value)).toBe(true);
  });

  it('OData endpoint returns 401/403 without a token', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KgOnDemandRequests?$top=1`);
    expect([401, 403]).toContain(res.status);
  });

  it('KnowledgeGraphSettings exposes onDemandExtractionEnabled', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KnowledgeGraphSettings`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value?.[0]).toHaveProperty('onDemandExtractionEnabled');
    expect(typeof body.value[0].onDemandExtractionEnabled).toBe('boolean');
  });
});
