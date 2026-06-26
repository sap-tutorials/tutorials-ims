// test/unit/auth-user-endpoint.test.js
//
// Issue #617 — expose `isAuthor` on `/auth/user` so the admin-shell can derive
// `userRole === 'author'` at boot. Verifies the new field is present alongside
// the existing `isAdmin` boolean and reflects the caller's `Tutorial.Author`
// scope membership.
//
// Pattern mirrors test/unit/health-auth.test.js — same in-process cds.test
// harness, same mocked basic-auth fixtures.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('/auth/user', () => {
  let baseUrl;

  beforeAll(async () => {
    baseUrl = project.url;
  });

  it('includes isAuthor:false for a non-author mock user', async () => {
    const credentials = Buffer.from('alice:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('isAuthor');
    expect(typeof body.isAuthor).toBe('boolean');
    expect(body.isAuthor).toBe(false);
  });

  it('includes isAuthor:true for a Tutorial.Author mock user', async () => {
    const credentials = Buffer.from('author:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
  });
});
