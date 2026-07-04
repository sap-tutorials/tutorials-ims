// test/integration/homepage/persona-tag-admin-validation.test.js
//
// (#763) Integration tests for persona-tag save-time validation on AdminService.
// Verifies that CREATE on HomepageShelves rejects unknown persona tags with a
// 400+ response and accepts valid tags cleanly.
//
// Auth: admin/admin (matches .cdsrc.json mock users).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const adminAuth = { auth: { username: 'admin', password: 'admin' }, validateStatus: () => true };

describe('Admin persona-tag validation', () => {
  it('rejects unknown persona tag on HomepageShelves CREATE', async () => {
    const r = await project.post(
      '/admin/HomepageShelves',
      {
        verb: 'BUILD',
        shelf: 'START_HERE',
        title: 'X',
        url: 'https://x',
        personaTags: ['role:manager'],
      },
      adminAuth
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.data ?? r.body ?? '')).toMatch(/role:manager/);
  });

  it('accepts known tags on HomepageShelves CREATE', async () => {
    const r = await project.post(
      '/admin/HomepageShelves',
      {
        verb: 'BUILD',
        shelf: 'START_HERE',
        title: 'X',
        url: 'https://x',
        personaTags: ['role:developer', 'cloud:aws'],
        personaWeight: 5,
      },
      adminAuth
    );
    expect(r.status).toBeLessThan(400);
  });
});
