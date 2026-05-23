import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

// Load the full project so srv/server.js fires (registers the express bridge).
// Use 'serve' form consistent with other HTTP-level unit tests in this project.
const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };

describe('GET /admin/exports/exportLegacyData', () => {
  it('rejects an anonymous user with 401 or 403', async () => {
    const { status } = await project.get(
      '/admin/exports/exportLegacyData?format=csv',
      { validateStatus: () => true }
    );
    expect([401, 403]).toContain(status);
  });

  it('rejects an unsupported format with 400 (admin user)', async () => {
    const { status } = await project.get(
      '/admin/exports/exportLegacyData?format=parquet',
      { ...adminAuth, validateStatus: () => true }
    );
    expect(status).toBe(400);
  });

  it('returns a ZIP with content-disposition for format=csv (admin user)', async () => {
    const { status, headers } = await project.get(
      '/admin/exports/exportLegacyData?format=csv',
      { ...adminAuth, responseType: 'arraybuffer', validateStatus: () => true }
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('application/zip');
    expect(headers['content-disposition']).toMatch(
      /^attachment; filename="ims-export-csv-\d{8}-\d{6}\.zip"$/
    );
  });
});
