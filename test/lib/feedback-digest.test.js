// test/lib/feedback-digest.test.js
//
// #2188 — daily digest emailing tutorial owners when new feedback (comments)
// arrives. Real in-memory CAP harness so the slug→owner resolution joins and
// the TutorialFeedback window query run against a real DB (mocking those was
// the source of drift in earlier notification work). Sends are exercised via a
// dependency-injected `sendEmail` spy so no SMTP/boot mocking is needed.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

// Force the PROD env gate via a vcap override rather than mutating VCAP_APPLICATION.
const PROD_VCAP = JSON.stringify({ space_name: 'prod' });
const DEV_VCAP = JSON.stringify({ space_name: 'dev' });

let mod;

async function setFlag(value) {
  const { ImsConfig } = cds.entities(NS);
  await DELETE.from(ImsConfig).where({ key: 'feedback.email.enabled' });
  if (value !== undefined) {
    await INSERT.into(ImsConfig).entries({ key: 'feedback.email.enabled', value });
  }
  mod.resetFeedbackFlagCache();
}

async function clearWatermark() {
  const { ImsConfig } = cds.entities(NS);
  await DELETE.from(ImsConfig).where({ key: 'feedback.email.lastDigestAt' });
}

// Insert a Tutorials row (+ optional TutorialMeta / author / contributors) and
// return its ID. Keeps each test's fixture self-contained.
let seq = 0;
async function seedTutorial({ slug, title, ownerEmail, authorEmail, authorName, contributor }) {
  const { Tutorials, TutorialMeta, TutorialContributors, Users } = cds.entities(NS);
  seq += 1;
  const tutId = `feed0000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
  let author_ID = null;
  if (authorEmail) {
    author_ID = `user0000-0000-0000-0000-${String(seq).padStart(12, '0')}`;
    await INSERT.into(Users).entries({ ID: author_ID, email: authorEmail, displayName: authorName || 'Author Name' });
  }
  await INSERT.into(Tutorials).entries({ ID: tutId, slug, title: title || slug, legacyId: 70000 + seq, status: 'ACTIVE', author_ID });
  await INSERT.into(TutorialMeta).entries({
    ID: `meta0000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    tutorial_ID: tutId, ownerEmail: ownerEmail || null, monitoredStatus: 'ACTIVE', legacyId: 71000 + seq,
  });
  if (contributor) {
    await INSERT.into(TutorialContributors).entries({
      ID: `cont0000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
      tutorial_ID: tutId, name: contributor.name, email: contributor.email, role: contributor.role, legacyId: 72000 + seq,
    });
  }
  return tutId;
}

async function seedFeedback({ slug, comment, submittedAt, npsScore, ratingUseCase }) {
  const { TutorialFeedback } = cds.entities(NS);
  seq += 1;
  await INSERT.into(TutorialFeedback).entries({
    ID: `fbfb0000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    tutorialSlug: slug, comment: comment ?? null, submittedAt,
    npsScore: npsScore ?? null, ratingUseCase: ratingUseCase ?? null,
    wasAuthenticated: false,
  });
}

beforeAll(async () => {
  mod = await import('../../srv/lib/feedback-digest.js');
});

beforeEach(async () => {
  const { TutorialFeedback } = cds.entities(NS);
  await DELETE.from(TutorialFeedback);
  await clearWatermark();
  mod.resetFeedbackFlagCache();
});

describe('isFeedbackEmailActive — double gate (prod + DB flag)', () => {
  it('active only when prod AND flag=true', async () => {
    await setFlag('true');
    expect(await mod.isFeedbackEmailActive(cds.db, PROD_VCAP)).toBe(true);
  });

  it('inactive in non-prod even with flag on', async () => {
    await setFlag('true');
    expect(await mod.isFeedbackEmailActive(cds.db, DEV_VCAP)).toBe(false);
  });

  it('inactive when flag missing or not "true" (fail-closed)', async () => {
    await setFlag(undefined);
    expect(await mod.isFeedbackEmailActive(cds.db, PROD_VCAP)).toBe(false);
    await setFlag('false');
    expect(await mod.isFeedbackEmailActive(cds.db, PROD_VCAP)).toBe(false);
  });
});

describe('resolveOwnerRecipient — ownerEmail then author-chain fallback', () => {
  it('prefers TutorialMeta.ownerEmail', async () => {
    await seedTutorial({ slug: 'own-email', ownerEmail: 'Owner@sap.com', authorEmail: 'author@sap.com' });
    const r = await mod.resolveOwnerRecipient('own-email', cds.db);
    expect(r.email).toBe('owner@sap.com'); // lowercased
    expect(r.source).toBe('TutorialMeta.ownerEmail');
  });

  it('falls back to Tutorials.author.email when ownerEmail blank', async () => {
    await seedTutorial({ slug: 'author-fb', ownerEmail: '', authorEmail: 'author@sap.com', authorName: 'Ada' });
    const r = await mod.resolveOwnerRecipient('author-fb', cds.db);
    expect(r.email).toBe('author@sap.com');
    expect(r.source).toBe('Tutorials.author');
    expect(r.name).toBe('Ada');
  });

  it('falls back to OWNER/AUTHOR contributor when no ownerEmail/author', async () => {
    await seedTutorial({ slug: 'contrib-fb', contributor: { name: 'Con', email: 'con@sap.com', role: 'OWNER' } });
    const r = await mod.resolveOwnerRecipient('contrib-fb', cds.db);
    expect(r.email).toBe('con@sap.com');
    expect(r.source).toBe('TutorialContributors');
  });

  it('returns null when nothing resolvable', async () => {
    await seedTutorial({ slug: 'no-owner' });
    expect(await mod.resolveOwnerRecipient('no-owner', cds.db)).toBeNull();
  });

  it('returns null when the slug has no tutorial', async () => {
    expect(await mod.resolveOwnerRecipient('ghost-slug', cds.db)).toBeNull();
  });
});

describe('computeFeedbackDigests — comment filter, window, grouping', () => {
  it('excludes rating-only (no comment) submissions', async () => {
    await seedTutorial({ slug: 'ro-a', ownerEmail: 'a@sap.com' });
    await seedFeedback({ slug: 'ro-a', comment: null, submittedAt: '2026-09-01T10:00:00Z', npsScore: 9 });
    await seedFeedback({ slug: 'ro-a', comment: '   ', submittedAt: '2026-09-01T10:01:00Z' });
    const digests = await mod.computeFeedbackDigests({ since: '2026-08-01T00:00:00Z', until: '2026-09-07T00:00:00Z' }, cds.db);
    expect(digests).toEqual([]);
  });

  it('groups commented feedback across tutorials by owner email', async () => {
    await seedTutorial({ slug: 'grp-a', title: 'Tut A', ownerEmail: 'owner@sap.com' });
    await seedTutorial({ slug: 'grp-b', title: 'Tut B', ownerEmail: 'owner@sap.com' });
    await seedTutorial({ slug: 'grp-c', title: 'Tut C', ownerEmail: 'other@sap.com' });
    await seedFeedback({ slug: 'grp-a', comment: 'great', submittedAt: '2026-09-01T10:00:00Z', npsScore: 8 });
    await seedFeedback({ slug: 'grp-b', comment: 'nice', submittedAt: '2026-09-02T10:00:00Z' });
    await seedFeedback({ slug: 'grp-c', comment: 'hmm', submittedAt: '2026-09-03T10:00:00Z' });

    const digests = await mod.computeFeedbackDigests({ since: '2026-08-01T00:00:00Z', until: '2026-09-07T00:00:00Z' }, cds.db);
    const owner = digests.find(d => d.email === 'owner@sap.com');
    const other = digests.find(d => d.email === 'other@sap.com');
    expect(owner.items).toHaveLength(2);
    expect(other.items).toHaveLength(1);
  });

  it('respects the (since, until] window', async () => {
    await seedTutorial({ slug: 'win-a', ownerEmail: 'a@sap.com' });
    await seedFeedback({ slug: 'win-a', comment: 'too old', submittedAt: '2026-08-31T23:59:59Z' });
    await seedFeedback({ slug: 'win-a', comment: 'in window', submittedAt: '2026-09-02T10:00:00Z' });
    await seedFeedback({ slug: 'win-a', comment: 'too new', submittedAt: '2026-09-10T10:00:00Z' });
    const digests = await mod.computeFeedbackDigests({ since: '2026-09-01T00:00:00Z', until: '2026-09-07T00:00:00Z' }, cds.db);
    expect(digests[0].items).toHaveLength(1);
    expect(digests[0].items[0].comment).toBe('in window');
  });

  it('buckets unresolved-owner feedback under email:null', async () => {
    await seedTutorial({ slug: 't-x' }); // no owner resolvable
    await seedFeedback({ slug: 't-x', comment: 'orphan', submittedAt: '2026-09-02T10:00:00Z' });
    const digests = await mod.computeFeedbackDigests({ since: '2026-09-01T00:00:00Z', until: '2026-09-07T00:00:00Z' }, cds.db);
    expect(digests).toHaveLength(1);
    expect(digests[0].email).toBeNull();
    expect(digests[0].items).toHaveLength(1);
  });
});

describe('sendFeedbackDigests — orchestration + watermark', () => {
  it('gate off → no send, watermark untouched', async () => {
    await setFlag('false');
    const sendEmail = vi.fn().mockResolvedValue({ success: true });
    const res = await mod.sendFeedbackDigests(null, { db: cds.db, vcap: PROD_VCAP, sendEmail });
    expect(res.active).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
    const { ImsConfig } = cds.entities(NS);
    const wm = await SELECT.one.from(ImsConfig).where({ key: 'feedback.email.lastDigestAt' });
    expect(wm).toBeUndefined();
  });

  it('sends one email per owner and advances the watermark', async () => {
    await setFlag('true');
    await seedTutorial({ slug: 's-a', title: 'S A', ownerEmail: 'owner@sap.com' });
    await seedTutorial({ slug: 's-b', title: 'S B', ownerEmail: 'owner@sap.com' });
    await seedTutorial({ slug: 's-c', title: 'S C', ownerEmail: 'other@sap.com' });
    const now = Date.now();
    await seedFeedback({ slug: 's-a', comment: 'c1', submittedAt: new Date(now - 3600_000).toISOString(), npsScore: 9 });
    await seedFeedback({ slug: 's-b', comment: 'c2', submittedAt: new Date(now - 1800_000).toISOString() });
    await seedFeedback({ slug: 's-c', comment: 'c3', submittedAt: new Date(now - 900_000).toISOString() });
    // Seed a watermark far enough back that all three are in-window.
    const { ImsConfig } = cds.entities(NS);
    await INSERT.into(ImsConfig).entries({ key: 'feedback.email.lastDigestAt', value: new Date(now - 86400_000).toISOString() });

    const sendEmail = vi.fn().mockResolvedValue({ success: true });
    const res = await mod.sendFeedbackDigests(null, { db: cds.db, vcap: PROD_VCAP, sendEmail, publicBaseUrl: 'https://developers.sap.com' });

    expect(res.active).not.toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(2); // owner@ + other@
    const recipients = sendEmail.mock.calls.map(c => c[0].to).sort();
    expect(recipients).toEqual(['other@sap.com', 'owner@sap.com']);
    const ownerCall = sendEmail.mock.calls.find(c => c[0].to === 'owner@sap.com')[0];
    expect(ownerCall.template).toBe('feedback-digest');
    expect(ownerCall.variables.feedbackListHtml).toContain('c1');
    expect(ownerCall.variables.feedbackListHtml).toContain('c2');
    // Per-item public tutorial links (slug lowercased).
    expect(ownerCall.variables.feedbackListHtml).toContain('https://developers.sap.com/tutorials/s-a.html');
    expect(ownerCall.variables.feedbackListHtml).toContain('https://developers.sap.com/tutorials/s-b.html');
    // Per-item admin deep link (router hash form, keyed by tutorial UUID).
    expect(ownerCall.variables.feedbackListHtml).toContain('https://developers.sap.com/admin-ui/#tutorials&/tu/Tutorials(');
    // Footer links to the feedback dashboard, not the freestyle approuter dashboard.
    expect(ownerCall.variables.dashboardUrl).toBe('https://developers.sap.com/admin-ui/#feedback/dashboard');

    const wm = await SELECT.one.from(ImsConfig).where({ key: 'feedback.email.lastDigestAt' });
    expect(new Date(wm.value).getTime()).toBeGreaterThan(now - 60_000);
  });

  it('does NOT email the unresolved-owner bucket, but still advances watermark', async () => {
    await setFlag('true');
    await seedTutorial({ slug: 's-orphan' }); // no owner
    const now = Date.now();
    await seedFeedback({ slug: 's-orphan', comment: 'orphan', submittedAt: new Date(now - 900_000).toISOString() });
    const { ImsConfig } = cds.entities(NS);
    await INSERT.into(ImsConfig).entries({ key: 'feedback.email.lastDigestAt', value: new Date(now - 86400_000).toISOString() });

    const sendEmail = vi.fn().mockResolvedValue({ success: true });
    const res = await mod.sendFeedbackDigests(null, { db: cds.db, vcap: PROD_VCAP, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(res.skipped).toBe(1);
    const wm = await SELECT.one.from(ImsConfig).where({ key: 'feedback.email.lastDigestAt' });
    expect(new Date(wm.value).getTime()).toBeGreaterThan(now - 60_000);
  });

  it('first active run with no prior watermark sends no backlog (window starts now)', async () => {
    await setFlag('true');
    await seedTutorial({ slug: 's-old', ownerEmail: 'owner@sap.com' });
    // Feedback from an hour ago, but no watermark yet → should NOT be emailed.
    await seedFeedback({ slug: 's-old', comment: 'historical', submittedAt: new Date(Date.now() - 3600_000).toISOString() });
    const sendEmail = vi.fn().mockResolvedValue({ success: true });
    await mod.sendFeedbackDigests(null, { db: cds.db, vcap: PROD_VCAP, sendEmail });
    expect(sendEmail).not.toHaveBeenCalled();
    // watermark is now seeded so the next run has a real window.
    const { ImsConfig } = cds.entities(NS);
    const wm = await SELECT.one.from(ImsConfig).where({ key: 'feedback.email.lastDigestAt' });
    expect(wm).toBeDefined();
  });
});

describe('renderFeedbackList — per-item public + admin links', () => {
  const BASE = 'https://developers.sap.com';

  it('always emits a public tutorial link with lowercased slug', () => {
    const html = mod.renderFeedbackList(
      [{ slug: 'CAP-Handlers', title: 'T', comment: 'c', submittedAt: '2026-09-16', tutorialId: null }],
      BASE,
    );
    expect(html).toContain(`<a href="${BASE}/tutorials/cap-handlers.html">View tutorial</a>`);
  });

  it('emits the admin deep link (router hash form) only when tutorialId is present', () => {
    const withId = mod.renderFeedbackList(
      [{ slug: 's', title: 'T', comment: 'c', submittedAt: '2026-09-16', tutorialId: 'abc-123' }],
      BASE,
    );
    expect(withId).toContain(`${BASE}/admin-ui/#tutorials&/tu/Tutorials(abc-123)`);
    expect(withId).toContain('Edit in Admin UI');

    const noId = mod.renderFeedbackList(
      [{ slug: 's', title: 'T', comment: 'c', submittedAt: '2026-09-16', tutorialId: null }],
      BASE,
    );
    expect(noId).not.toContain('Edit in Admin UI');
    expect(noId).not.toContain('#tutorials&');
  });

  it('escapes title and comment', () => {
    const html = mod.renderFeedbackList(
      [{ slug: 's', title: '<b>x</b>', comment: 'a & "b"', submittedAt: '2026-09-16', tutorialId: null }],
      BASE,
    );
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('a &amp; &quot;b&quot;');
    expect(html).not.toContain('<b>x</b>');
  });
});
