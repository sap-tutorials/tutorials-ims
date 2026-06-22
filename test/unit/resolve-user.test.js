// test/unit/resolve-user.test.js
// Tests for the user-resolution helper that handles the gap between
// cds.context.user and req.user. Added 2026-06-22 after Tom hit a 401
// "Authentication required" on Advocate photo upload even with PR #535's
// fix in place — multer's busboy parser dropped the AsyncLocalStorage
// scope, so cds.context.user was null/anonymous in the handler.

import { describe, it, expect } from 'vitest';
import { pickAuthenticatedUser, resolveUser, captureUserMiddleware } from '../../srv/lib/resolve-user.js';

describe('pickAuthenticatedUser', () => {
  it('returns null when given no candidates', () => {
    expect(pickAuthenticatedUser()).toBeNull();
  });

  it('returns null when all candidates are null/undefined', () => {
    expect(pickAuthenticatedUser(null, undefined)).toBeNull();
  });

  it('returns null when a candidate lacks an id', () => {
    expect(pickAuthenticatedUser({ name: 'Alice' })).toBeNull();
  });

  it('returns null when the only candidate is anonymous', () => {
    expect(pickAuthenticatedUser({ id: 'anonymous' })).toBeNull();
  });

  it('returns the first candidate that has a real id', () => {
    const real = { id: 'alice@example.com' };
    expect(pickAuthenticatedUser(real)).toBe(real);
  });

  it('skips anonymous candidates to find a real one (the Advocates photo upload case)', () => {
    // Simulates the deployed-XSUAA + multer scenario: req.user might be
    // empty/anonymous because the auth middleware's mirror to req.user
    // failed, but cds.context.user has the real Admin user.
    const reqUser = { id: 'anonymous' };
    const ctxUser = { id: 'admin@example.com', is: () => true };
    expect(pickAuthenticatedUser(reqUser, ctxUser)).toBe(ctxUser);
  });

  it('skips null/missing candidates to find one with an id', () => {
    const ctxUser = { id: 'admin@example.com' };
    expect(pickAuthenticatedUser(null, ctxUser, undefined)).toBe(ctxUser);
  });

  it('returns the FIRST authenticated candidate (left-to-right priority)', () => {
    const captured = { id: 'admin@captured.com' };
    const ctx = { id: 'admin@ctx.com' };
    expect(pickAuthenticatedUser(captured, ctx)).toBe(captured);
  });
});

describe('resolveUser', () => {
  it('prefers req._capturedUser (stashed before stream parsers ran)', () => {
    const req = {
      _capturedUser: { id: 'captured@example.com' },
      user: { id: 'anonymous' },
    };
    const cds = { context: { user: { id: 'anonymous' } } };
    expect(resolveUser(req, cds).id).toBe('captured@example.com');
  });

  it('falls through to cds.context.user when capture is null/anonymous', () => {
    const req = { _capturedUser: null, user: null };
    const cds = { context: { user: { id: 'ctx@example.com' } } };
    expect(resolveUser(req, cds).id).toBe('ctx@example.com');
  });

  it('falls through to req.user as the last resort', () => {
    const req = { _capturedUser: null, user: { id: 'reqonly@example.com' } };
    const cds = { context: { user: { id: 'anonymous' } } };
    expect(resolveUser(req, cds).id).toBe('reqonly@example.com');
  });

  it('returns null when every surface is null/anonymous', () => {
    const req = { _capturedUser: { id: 'anonymous' }, user: null };
    const cds = { context: { user: { id: 'anonymous' } } };
    expect(resolveUser(req, cds)).toBeNull();
  });

  it('tolerates missing cds.context (no AsyncLocalStorage scope at all)', () => {
    const req = { _capturedUser: { id: 'captured@example.com' } };
    const cds = {};
    expect(resolveUser(req, cds).id).toBe('captured@example.com');
  });
});

describe('captureUserMiddleware', () => {
  it('captures cds.context.user onto req._capturedUser', () => {
    const cds = { context: { user: { id: 'admin@example.com' } } };
    const middleware = captureUserMiddleware(cds);
    const req = {};
    const next = () => {};
    middleware(req, {}, next);
    expect(req._capturedUser?.id).toBe('admin@example.com');
  });

  it('falls back to req.user when cds.context.user is anonymous', () => {
    const cds = { context: { user: { id: 'anonymous' } } };
    const middleware = captureUserMiddleware(cds);
    const req = { user: { id: 'real@example.com' } };
    const next = () => {};
    middleware(req, {}, next);
    expect(req._capturedUser?.id).toBe('real@example.com');
  });

  it('stashes null when neither surface has a real user', () => {
    const cds = { context: { user: { id: 'anonymous' } } };
    const middleware = captureUserMiddleware(cds);
    const req = { user: null };
    const next = () => {};
    middleware(req, {}, next);
    expect(req._capturedUser).toBeNull();
  });

  it('always calls next() exactly once', () => {
    let nextCalls = 0;
    const cds = { context: { user: { id: 'admin@example.com' } } };
    const middleware = captureUserMiddleware(cds);
    middleware({}, {}, () => { nextCalls++; });
    expect(nextCalls).toBe(1);
  });
});
