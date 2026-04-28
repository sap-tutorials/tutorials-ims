import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const devAuth = { auth: { username: 'developer', password: 'developer' } };
const displayAuth = { auth: { username: 'display', password: 'display' } };
const consolidationAuth = { auth: { username: 'consolidation', password: 'consolidation' } };

describe('deployment smoke tests', () => {

  describe('service registration', () => {
    it('DeveloperService is served at /api', async () => {
      const res = await project.get('/api/$metadata', devAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('DeveloperService');
    });

    it('AdminService is served at /admin', async () => {
      const res = await project.get('/admin/$metadata', adminAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('AdminService');
    });

    it('DisplayService is served at /display', async () => {
      const res = await project.get('/display/$metadata', displayAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('DisplayService');
    });

    it('ConsolidationService is served at /api/v1', async () => {
      const res = await project.get('/api/v1/$metadata', consolidationAuth);
      expect(res.status).toBe(200);
      expect(res.data).toContain('ConsolidationService');
    });
  });

  describe('authentication enforcement', () => {
    it('rejects unauthenticated requests to /admin', async () => {
      const { status } = await project.get('/admin/Users', { validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('rejects DeveloperApp scope on /admin', async () => {
      const { status } = await project.get('/admin/Users',
        { ...devAuth, validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('rejects DisplayApp scope on /admin', async () => {
      const { status } = await project.get('/admin/Users',
        { ...displayAuth, validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });

    it('allows Admin scope on /admin', async () => {
      const res = await project.get('/admin/Users', adminAuth);
      expect(res.status).toBe(200);
    });

    it('rejects unauthenticated requests to /api/v1', async () => {
      const { status } = await project.get('/api/v1/getMergeStatus(uuid=\'test\')',
        { validateStatus: () => true });
      expect([401, 403]).toContain(status);
    });
  });

  describe('HANA sequence integration (hybrid only)', () => {
    it.skipIf(!process.env.CDS_ENV?.includes('hybrid'))('getNextLegacyId returns numeric sequence value', async () => {
      const { getNextLegacyId } = await import('../srv/lib/legacy-id.js');
      const db = await cds.connect.to('db');
      const id = await getNextLegacyId('TaskRecords', db);
      expect(typeof id).toBe('number');
      expect(id).toBeGreaterThan(10000000);
    });
  });

  describe('build catalog (unauthenticated)', () => {
    it('GET /build/catalog returns missions and hierarchies', async () => {
      const res = await project.get('/build/catalog', { validateStatus: () => true });
      expect(res.status).toBe(200);
      expect(res.data).toHaveProperty('missions');
      expect(res.data).toHaveProperty('hierarchies');
      expect(Array.isArray(res.data.missions)).toBe(true);
      expect(Array.isArray(res.data.hierarchies)).toBe(true);
    });
  });
});
