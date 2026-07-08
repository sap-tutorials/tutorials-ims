// srv/__tests__/lib/tag-md-format-handlers.test.js
//
// Behavioral guard for the before('READ') interceptor in
// attachTagsMdFormatHandlers. We stub the CAP srv object so we can capture
// the registered before/after callbacks, feed them a hand-rolled req, and
// assert the SELECT rewrite behavior.
//
// #1075 — an mdFormat filter literal containing `>` or `-` MUST NOT be
// rewritten to a titlePath push-down; that rewrite is a strict UNDER-set
// (the SAP Community regression) and returns zero rows.

import { describe, it, expect } from 'vitest';
import { attachTagsMdFormatHandlers } from '../../lib/tag-md-format-handlers.js';

function cqn_containsTolower(field, value) {
  return {
    func: 'contains',
    args: [
      { func: 'tolower', args: [{ ref: [field] }] },
      { val: value },
    ],
  };
}

// Tiny CAP-srv fake: captures the last before/after callback per hook.
function makeSrvStub() {
  const captured = { before: null, after: null };
  return {
    before(hook, entity, cb) { captured.before = { hook, entity, cb }; },
    after(hook, entity, cb) { captured.after = { hook, entity, cb }; },
    captured,
  };
}

// Construct a minimal req shape: { query: { SELECT: { where, limit, count, orderBy } } }.
function makeReq(where) {
  return {
    query: {
      SELECT: {
        where,
        limit: { rows: { val: 10 }, offset: { val: 0 } },
        count: true,
        orderBy: [{ ref: ['name'], sort: 'asc' }],
      },
    },
  };
}

describe('attachTagsMdFormatHandlers — before(READ) mdFormat filter rewrite (#1075)', () => {
  it('rewrites mdFormat → titlePath when the literal is a plain word (safe)', () => {
    const srv = makeSrvStub();
    attachTagsMdFormatHandlers(srv, 'Tags');
    const req = makeReq([cqn_containsTolower('mdFormat', 'business')]);

    srv.captured.before.cb(req);

    // Push-down active: mdFormat ref replaced by titlePath in the SQL where.
    expect(req.query.SELECT.where).toBeDefined();
    const serialized = JSON.stringify(req.query.SELECT.where);
    expect(serialized).toContain('"titlePath"');
    expect(serialized).not.toContain('"mdFormat"');
    // Broadened scan: limit widened, count cleared for local recomputation.
    expect(req.query.SELECT.limit.rows.val).toBeGreaterThan(1000);
    expect(req.query.SELECT.count).toBe(false);
  });

  it('SKIPS SQL narrowing when the literal contains `>` (#1075 SAP Community case)', () => {
    const srv = makeSrvStub();
    attachTagsMdFormatHandlers(srv, 'Tags');
    const req = makeReq([
      cqn_containsTolower('name', 'topic>sap-community'),
      'or',
      cqn_containsTolower('mdFormat', 'topic>sap-community'),
    ]);

    srv.captured.before.cb(req);

    // WHERE is cleared — the DB scans up to the ceiling and JS post-filter
    // (which sees the enriched mdFormat) does the real matching.
    expect(req.query.SELECT.where).toBeUndefined();
    // Broadened scan still applied.
    expect(req.query.SELECT.limit.rows.val).toBeGreaterThan(1000);
    expect(req.query.SELECT.count).toBe(false);
    // Stash still records the ORIGINAL where so after('READ') runs the true filter.
    expect(req._mdFormatFilterStash).toBeDefined();
    expect(req._mdFormatFilterStash.where).toBeDefined();
  });

  it('SKIPS SQL narrowing when the literal contains a hyphen', () => {
    const srv = makeSrvStub();
    attachTagsMdFormatHandlers(srv, 'Tags');
    const req = makeReq([cqn_containsTolower('mdFormat', 'sap-community')]);

    srv.captured.before.cb(req);

    expect(req.query.SELECT.where).toBeUndefined();
  });

  it('leaves the query alone when the filter never touches mdFormat', () => {
    const srv = makeSrvStub();
    attachTagsMdFormatHandlers(srv, 'Tags');
    const originalWhere = [cqn_containsTolower('name', 'business')];
    const req = makeReq(originalWhere);

    srv.captured.before.cb(req);

    // No mdFormat ref → no stash, no rewrite, no broadening.
    expect(req._mdFormatFilterStash).toBeUndefined();
    expect(req.query.SELECT.where).toBe(originalWhere);
    expect(req.query.SELECT.limit.rows.val).toBe(10);
    expect(req.query.SELECT.count).toBe(true);
  });

  it('after(READ) still finds the SAP Community row with WHERE cleared and full scan', () => {
    // End-to-end simulation: the before() clears WHERE (fake scan returns
    // representative rows), then after() enriches mdFormat and applies the
    // original predicate. Confirms the two halves compose.
    const srv = makeSrvStub();
    attachTagsMdFormatHandlers(srv, 'Tags');
    const req = makeReq([
      cqn_containsTolower('name', 'topic>sap-community'),
      'or',
      cqn_containsTolower('mdFormat', 'topic>sap-community'),
    ]);

    srv.captured.before.cb(req);

    // Simulate the DB returning a representative page (unfiltered).
    const rows = [
      { ID: '1', name: 'SAP Community', titlePath: 'Topic : SAP Community' },
      { ID: '2', name: 'Business Suite', titlePath: 'Topic : Business Suite' },
      { ID: '3', name: 'SAP HANA', titlePath: 'Software Product : Technology Platform / SAP HANA' },
    ];
    // Mock res.setHeader — the after() writes odata-count there.
    req.res = { setHeader: () => {} };
    srv.captured.after.cb(rows, req);

    // Enrichment ran, JS post-filter matched the SAP Community row via mdFormat.
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('SAP Community');
    expect(rows[0].mdFormat).toBe('topic>sap-community');
  });
});
