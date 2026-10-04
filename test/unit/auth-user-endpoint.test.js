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

  it('includes an environment object (LOCAL when not on CF) for authenticated callers', async () => {
    const credentials = Buffer.from('author:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    const body = await res.json();
    expect(body.environment).toBeTruthy();
    expect(body.environment).toMatchObject({ id: 'local', label: 'LOCAL' });
  });

  it('includes the environment object even on the anonymous 401 path', async () => {
    const res = await fetch(`${baseUrl}/auth/user`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.authenticated).toBe(false);
    expect(body.environment).toMatchObject({ id: 'local', label: 'LOCAL' });
  });

  // Issue #2615 — expose the originating IdP so the client can target "Manage
  // my Account" (sap.default → account.sap.com, sap.custom → the IAS tenant).
  it('reflects attr.origin=sap.custom as identityProvider', async () => {
    const credentials = Buffer.from('idpcustom:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.identityProvider).toBe('sap.custom');
  });

  it('reflects attr.origin=sap.default as identityProvider', async () => {
    const credentials = Buffer.from('idpdefault:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    const body = await res.json();
    expect(body.identityProvider).toBe('sap.default');
  });

  it('includes identityProvider:null when the caller carries no origin/issuer', async () => {
    const credentials = Buffer.from('author:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    const body = await res.json();
    expect(body).toHaveProperty('identityProvider');
    expect(body.identityProvider).toBeNull();
  });

  // Issue #2628 — surface the login-provider profile picture (OIDC `picture`
  // claim). The live token claim is freshest, so it wins over the persisted
  // Users.pictureUrl; with no Khoros link, avatarUrl resolves to it.
  it('exposes attr.picture as pictureUrl and avatarUrl (no Khoros link)', async () => {
    const credentials = Buffer.from('withpicture:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pictureUrl).toBe('https://avatars.githubusercontent.com/u/42?v=4');
    expect(body.avatarUrl).toBe('https://avatars.githubusercontent.com/u/42?v=4');
  });

  it('emits pictureUrl:null and avatarUrl:null for a caller with no picture claim', async () => {
    const credentials = Buffer.from('author:').toString('base64');
    const res = await fetch(`${baseUrl}/auth/user`, {
      headers: { Authorization: `Basic ${credentials}` }
    });
    const body = await res.json();
    expect(body).toHaveProperty('pictureUrl');
    expect(body).toHaveProperty('avatarUrl');
    expect(body.pictureUrl).toBeNull();
    expect(body.avatarUrl).toBeNull();
  });
});
