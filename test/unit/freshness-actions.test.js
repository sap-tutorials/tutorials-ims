// test/unit/freshness-actions.test.js
// Tests for the checkFreshness and setDisposition service actions (task-7).
//
// Adaptation notes (vs. brief's srv.send form):
//
// 1. CALL FORM: `srv.tx({ user }, tx => tx.send(...))` deadlocks on SQLite because
//    `persistReport` calls `db.tx()` inside the service transaction. This project's
//    established pattern for bound actions on Tutorials (author-service-rebuild.test.js)
//    is HTTP-level calls via the cds.test project helper. We follow that pattern.
//
// 2. AUTH ANNOTATION: Brief's `@(requires: 'Author')` adapted to
//    `@(requires: 'Tutorial.Author')` to match this project's role-name convention.
//    Mock 'admin' user holds Tutorial.Author (plus Admin for AdminService gate).
//
// 3. TEST HOOK: `groundCodeBlock` calls `embed()` which hangs on TCP waiting for
//    AI Core (no binding in unit tests; the 30s OS TCP timeout is longer than the
//    test timeout). A top-level `globalThis.__FRESHNESS_DETECT_IMPL__` hook was added
//    to `detectFreshness` (one-line addition to freshness-detector.js) so unit tests
//    can bypass ALL network I/O. The `__FRESHNESS_TEST_IMPL__` hook from the brief
//    is honoured for LLM-level bypass in integration contexts; in unit tests the
//    top-level hook is the correct entry point.

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

// Module-level bootstrap — CDS server starts once per test file.
const project = cds.test('serve', '--project', '.', '--in-memory');

describe('freshness service actions', () => {
  beforeAll(() => {});  // ensure cds.test's beforeAll runs first

  afterEach(() => {
    delete globalThis.__FRESHNESS_DETECT_IMPL__;
    delete globalThis.__FRESHNESS_TEST_IMPL__;
  });

  it('checkFreshness runs detection and persists a DONE report', async () => {
    const { POST } = project;
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'freshact', title: 'Act', legacyId: 9901 });

    // Top-level hook bypasses all network calls (grounding + LLM).
    globalThis.__FRESHNESS_DETECT_IMPL__ = async () => ({
      model: 'anthropic--claude-4.6-sonnet',
      costCents: 5,
      findings: [{
        category: 'obsolete-dep', severity: 'High', confidence: 'High',
        stepRef: 1, codeBlockIndex: 0, lang: 'js',
        evidence: 'require("node-fetch")', summary: 's',
        suggestedFix: 'f', groundingSource: 'https://x',
      }],
    });

    const res = await POST(
      `/admin/Tutorials(${tid})/AdminService.checkFreshness`,
      {},
      { auth: { username: 'admin', password: 'admin' } },
    );
    expect(res.status).toBe(200);
    // CAP wraps single-return-type action results in .value on some versions
    expect(res.data.value?.status ?? res.data.status).toBe('DONE');

    const { FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const findings = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    expect(findings).toHaveLength(1);
  });

  it('setDisposition updates a finding', async () => {
    const { POST } = project;
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    const rid = cds.utils.uuid();
    const fid = cds.utils.uuid();

    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'freshdisp', title: 'D', legacyId: 9902 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE' });
    await INSERT.into(FreshnessFinding).entries({
      ID: fid, report_ID: rid, tutorial_ID: tid,
      fingerprint: 'fp9902', category: 'dated-style',
      severity: 'Low', confidence: 'Low', disposition: 'OPEN',
    });

    const res = await POST(
      `/admin/FreshnessFinding(${fid})/AdminService.setDisposition`,
      { disposition: 'FIXED', note: 'done' },
      { auth: { username: 'admin', password: 'admin' } },
    );
    expect(res.status).toBe(200);
    expect(res.data.value?.status ?? res.data.status).toBe('ok');

    const f = await SELECT.one.from(FreshnessFinding).where({ ID: fid });
    expect(f.disposition).toBe('FIXED');
  });
});
