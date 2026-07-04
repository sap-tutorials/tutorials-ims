import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import cds from '@sap/cds';
import { registerMigrationModeHandler } from '../../srv/lib/migration-mode.js';

describe('migration-mode handler routing', () => {
  let beforeHandler;
  let afterHandler;
  let originalContext;

  beforeEach(() => {
    beforeHandler = null;
    afterHandler = null;

    const fakeDb = {
      before: (events, fn) => {
        // Sanity-check the registration shape
        expect(events).toEqual(['INSERT', 'UPDATE', 'DELETE']);
        beforeHandler = fn;
      },
      after: (events, fn) => {
        expect(events).toEqual(['INSERT', 'UPDATE', 'DELETE']);
        afterHandler = fn;
      },
    };
    registerMigrationModeHandler(fakeDb);

    // Save current cds.context so we can restore it; cds v9 allows assignment.
    originalContext = cds.context;
  });

  afterEach(() => {
    // Restore — if the value can't be restored (read-only setter), at least
    // null it so subsequent tests in this file don't see leaked state.
    try {
      cds.context = originalContext;
    } catch {
      // ignore
    }
  });

  function setContext(ctx) {
    // Self-reference `ctx.context = ctx` bypasses CAP's `EventContext.for(x)`
    // wrapping (see `@sap/cds/lib/index.js` — the setter uses `x.context ||
    // EventContext.for(x)`). Without this shortcut, `EventContext.for(x)`
    // sets `_propagated = cds.context`, so `http` / `user` from the previous
    // `it`'s `setContext` bleed through even across `afterEach`-restored
    // undefined resets — because Vitest 4 + Node 22 (forks pool) creates
    // each `it` in a new async task whose AsyncLocalStorage inherits the
    // parent scope's frozen store, and `enterWith(undefined)` inside
    // `beforeEach`/`afterEach` doesn't propagate back to that parent scope.
    // Self-ref sidesteps the whole propagation chain.
    ctx.context = ctx;
    cds.context = ctx;
  }

  function fakeReq() {
    return { _tx: { set: vi.fn() }, event: 'CREATE', target: { name: 'Advocates' } };
  }

  it('header present + Admin role → sets ct.skip="true" and flag', async () => {
    setContext({
      http: { req: { headers: { 'x-migration-mode': 'true' } } },
      user: { is: (r) => r === 'Admin' },
    });
    const req = fakeReq();
    await beforeHandler(req);

    expect(req._tx.set).toHaveBeenCalledTimes(1);
    expect(req._tx.set).toHaveBeenCalledWith({ 'ct.skip': 'true' });
    expect(req._migrationModeSkipSet).toBe(true);
  });

  it('header missing → does NOT set', async () => {
    setContext({
      http: { req: { headers: {} } },
      user: { is: () => true },
    });
    const req = fakeReq();
    await beforeHandler(req);

    expect(req._tx.set).not.toHaveBeenCalled();
    expect(req._migrationModeSkipSet).toBeUndefined();
  });

  it('header value other than "true" → does NOT set', async () => {
    setContext({
      http: { req: { headers: { 'x-migration-mode': 'false' } } },
      user: { is: () => true },
    });
    const req = fakeReq();
    await beforeHandler(req);

    expect(req._tx.set).not.toHaveBeenCalled();
    expect(req._migrationModeSkipSet).toBeUndefined();
  });

  it('non-Admin user → does NOT set', async () => {
    setContext({
      http: { req: { headers: { 'x-migration-mode': 'true' } } },
      user: { is: (r) => r !== 'Admin' },
    });
    const req = fakeReq();
    await beforeHandler(req);

    expect(req._tx.set).not.toHaveBeenCalled();
    expect(req._migrationModeSkipSet).toBeUndefined();
  });

  it('no http context (e.g. internal call) → does NOT set', async () => {
    setContext({ user: { is: () => true } });
    const req = fakeReq();
    await beforeHandler(req);

    expect(req._tx.set).not.toHaveBeenCalled();
    expect(req._migrationModeSkipSet).toBeUndefined();
  });

  it('after handler resets ct.skip to "false" when flag set', async () => {
    const req = fakeReq();
    req._migrationModeSkipSet = true;
    await afterHandler(null, req);

    expect(req._tx.set).toHaveBeenCalledTimes(1);
    expect(req._tx.set).toHaveBeenCalledWith({ 'ct.skip': 'false' });
    expect(req._migrationModeSkipSet).toBeUndefined();
  });

  it('after handler does NOTHING when flag not set', async () => {
    const req = fakeReq();
    await afterHandler(null, req);

    expect(req._tx.set).not.toHaveBeenCalled();
  });
});
