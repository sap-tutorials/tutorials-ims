import { describe, it, expect } from 'vitest';

const APPROUTER = process.env.SMOKE_BASE_URL;
const SRV       = process.env.SMOKE_SRV_URL;

describe.runIf(APPROUTER && SRV)('admin exports smoke', () => {
  it('rejects anonymous request to approuter (401, 302, or JS-redirect to XSUAA)', async () => {
    const res = await fetch(`${APPROUTER}/admin/exports/exportLegacyData?format=csv`, { redirect: 'manual' });
    // Approuter may respond with:
    //   - 401 (HEAD-style direct rejection)
    //   - 302 (server-side redirect to /oauth/authorize)
    //   - 200 with a tiny HTML body that JS-redirects to /oauth/authorize and
    //     stashes the URL fragment in a cookie (the browser-friendly path).
    // All three prove the route is XSUAA-protected.
    if (res.status === 200) {
      const body = await res.text();
      expect(body).toMatch(/\/oauth\/authorize/);
    } else {
      expect([401, 302]).toContain(res.status);
    }
  });

  // The remaining cases hit srv directly with a tech-user / smoke token
  // exposed via SMOKE_ADMIN_TOKEN. If the project does not provide one,
  // these cases must be skipped in CI but kept for ad-hoc local runs.
  const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN;
  describe.runIf(ADMIN_TOKEN)('with admin token', () => {
    it('GET csv: 200, content-type application/zip, ZIP magic', async () => {
      const res = await fetch(`${SRV}/admin/exports/exportLegacyData?format=csv`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="ims-export-csv-\d{8}-\d{6}\.zip"$/);
      const buf = Buffer.from(await res.arrayBuffer());
      // PK\x03\x04 = local file header signature
      expect(buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    });

    it('GET xlsx: 200, correct content-type, ZIP magic (xlsx is a zip container)', async () => {
      const res = await fetch(`${SRV}/admin/exports/exportLegacyData?format=xlsx`, {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    });
  });
});
