// srv/lib/feedback-digest.js
//
// #2188 — email tutorial owners when new *commented* feedback arrives.
//
// Design (approved): a DAILY digest, not per-submission. Once a day the job
// looks at TutorialFeedback rows written since the last run, keeps only those
// carrying a free-text comment (rating-only submissions are noise for the
// owner), resolves each tutorial's owner, groups by owner, and sends ONE email
// per owner listing their new comments.
//
// Two independent gates, BOTH must pass — mirrors ngds-autosend.js:
//   1. Environment gate — CF space_name === 'prod' (resolveDeployEnvironment).
//      DEV and PROD share one XSUAA tenant, so space name is the only
//      non-spoofable runtime signal.
//   2. DB kill-switch — ImsConfig key 'feedback.email.enabled' === 'true'.
//      Defaults OFF (missing row → disabled). DB-driven, not env (blue-green
//      deploys drop `cf set-env`), and flippable without a redeploy.
//
// Watermark: ImsConfig key 'feedback.email.lastDigestAt' holds the ISO of the
// last processed run. The window is (watermark, runStart]. On the FIRST active
// run (no watermark yet) `since` defaults to runStart, so an empty window is
// processed and the watermark is simply seeded — this avoids blasting the whole
// historical backlog the moment the flag is first flipped on in prod.
//
// Recipient resolution (per approved decision): TutorialMeta.ownerEmail first,
// then the author chain — Tutorials.author.email → TutorialContributors
// OWNER/AUTHOR. Unresolvable → the feedback is bucketed but NOT emailed (it
// still advances the watermark so it isn't retried forever).

import cds from '@sap/cds';
import { resolveDeployEnvironment } from './deploy-environment.js';
import { escapeHtml } from './contributor-notifications.js';
import { sendNotificationEmail } from './mail-client.js';

const NS = 'com.sap.developers.ims';

export const FEEDBACK_EMAIL_CONFIG_KEY = 'feedback.email.enabled';
export const FEEDBACK_WATERMARK_KEY = 'feedback.email.lastDigestAt';

// Match ngds-autosend's 60s flag TTL: flipping the kill-switch takes effect
// within a minute without a redeploy, without hammering ImsConfig.
const FLAG_TTL_MS = 60 * 1000;
let _flagCache = { value: false, at: 0 };

export function resetFeedbackFlagCache() {
  _flagCache = { value: false, at: 0 };
}

async function isFeedbackEmailEnabledInDb(db) {
  const now = Date.now();
  if (now - _flagCache.at < FLAG_TTL_MS) return _flagCache.value;
  let enabled = false;
  try {
    const { ImsConfig } = cds.entities(NS);
    const row = await db.run(
      SELECT.one.from(ImsConfig).columns('value').where({ key: FEEDBACK_EMAIL_CONFIG_KEY })
    );
    enabled = String(row?.value).toLowerCase() === 'true';
  } catch (err) {
    // Fail CLOSED: a config-read fault leaves owner emails OFF rather than
    // risk an unintended outbound burst.
    cds.log('feedback-digest').warn('feedback email flag read failed; treating as disabled:', err.message);
    enabled = false;
  }
  _flagCache = { value: enabled, at: now };
  return enabled;
}

/**
 * True when owner-feedback email is active in this runtime: CF space=prod AND
 * the DB kill-switch is on. Exported for the scheduler + tests.
 */
export async function isFeedbackEmailActive(db, vcapOverride) {
  const env = resolveDeployEnvironment(vcapOverride);
  if (env.id !== 'prod') return false;
  return isFeedbackEmailEnabledInDb(db);
}

/**
 * Resolve tutorial title + owner recipient for a slug. Internal — callers use
 * resolveOwnerRecipient() (recipient only) or computeFeedbackDigests() (which
 * also needs the title). Returns null when the slug has no tutorial.
 *
 * @returns {{tutorialId:string, title:string,
 *            recipient:({email:string, source:string, name:string|null}|null)}|null}
 */
async function resolveSlugInfo(slug, db) {
  const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities(NS);
  const slugLower = String(slug || '').toLowerCase();

  // Tutorials.author is an Association to Users — the path expression compiles
  // to a LEFT JOIN (NULL-safe when author is unset).
  const tut = await db.run(
    SELECT.one.from(Tutorials)
      .columns('ID', 'title', 'author.email as authorEmail', 'author.displayName as authorName')
      .where({ slug: slugLower })
  );
  if (!tut) return null;

  const meta = await db.run(
    SELECT.one.from(TutorialMeta).columns('ownerEmail', 'owner').where({ tutorial_ID: tut.ID })
  );

  let recipient = null;
  const ownerEmail = meta?.ownerEmail;
  if (ownerEmail && String(ownerEmail).trim() !== '') {
    recipient = { email: String(ownerEmail).toLowerCase(), source: 'TutorialMeta.ownerEmail', name: meta?.owner ?? null };
  } else if (tut.authorEmail && String(tut.authorEmail).trim() !== '') {
    recipient = { email: String(tut.authorEmail).toLowerCase(), source: 'Tutorials.author', name: tut.authorName ?? null };
  } else {
    const contributors = await db.run(
      SELECT.from(TutorialContributors).columns('name', 'email', 'role').where({ tutorial_ID: tut.ID })
    );
    const owner = contributors.find(c => c.role === 'OWNER') ?? contributors.find(c => c.role === 'AUTHOR');
    if (owner?.email && String(owner.email).trim() !== '') {
      recipient = { email: String(owner.email).toLowerCase(), source: 'TutorialContributors', name: owner.name ?? null };
    }
  }

  return { tutorialId: tut.ID, title: tut.title, recipient };
}

/**
 * Resolve the owner recipient for a tutorial slug, applying the approved
 * priority chain. Returns null when the slug is unknown or no owner resolves.
 */
export async function resolveOwnerRecipient(slug, db = cds.db) {
  const info = await resolveSlugInfo(slug, db);
  return info?.recipient ?? null;
}

function hasComment(row) {
  return row.comment != null && String(row.comment).trim() !== '';
}

/**
 * Build per-owner digests for commented feedback in the (since, until] window.
 * Rating-only submissions are excluded. Feedback whose owner cannot be resolved
 * is bucketed under email:null (the caller decides not to email it).
 *
 * @param {{since:string, until:string}} window  ISO timestamps.
 * @returns {Promise<Array<{email:string|null, name:string|null, source:string|null,
 *   items:Array<{slug:string, title:string, comment:string, submittedAt:string,
 *                npsScore:number|null, tutorialId:string|null}>}>>}
 */
export async function computeFeedbackDigests({ since, until }, db = cds.db) {
  const { TutorialFeedback } = cds.entities(NS);
  const rows = await db.run(
    SELECT.from(TutorialFeedback)
      .where`submittedAt > ${since} and submittedAt <= ${until}`
      .orderBy('submittedAt')
  );

  const commented = rows.filter(hasComment);
  if (commented.length === 0) return [];

  const slugCache = new Map(); // slug → resolveSlugInfo result (or null)
  const groups = new Map();    // key(email|__null__) → digest

  for (const row of commented) {
    const slug = row.tutorialSlug;
    if (!slugCache.has(slug)) slugCache.set(slug, await resolveSlugInfo(slug, db));
    const info = slugCache.get(slug);
    const recipient = info?.recipient ?? null;

    const key = recipient?.email ?? '__null__';
    let digest = groups.get(key);
    if (!digest) {
      digest = { email: recipient?.email ?? null, name: recipient?.name ?? null, source: recipient?.source ?? null, items: [] };
      groups.set(key, digest);
    }
    digest.items.push({
      slug,
      title: info?.title ?? slug,
      comment: row.comment,
      submittedAt: row.submittedAt,
      npsScore: row.npsScore ?? null,
      tutorialId: info?.tutorialId ?? null,
    });
  }

  return Array.from(groups.values());
}

/**
 * Pre-render the feedback <ul> for the digest email. Substituted as
 * ${feedbackListHtml} (resolveTemplate does not support iteration).
 */
export function renderFeedbackList(items) {
  const lis = items.map(it => {
    const title = escapeHtml(it.title);
    const comment = escapeHtml(it.comment);
    const date = it.submittedAt ? String(it.submittedAt).slice(0, 10) : '—';
    const nps = it.npsScore != null ? ` (NPS ${escapeHtml(it.npsScore)})` : '';
    return `<li><strong>${title}</strong> — ${date}${nps}<br/>${comment}</li>`;
  });
  return `<ul>${lis.join('')}</ul>`;
}

/**
 * Subject line for an owner's feedback digest. Pluralizes the noun.
 */
export function feedbackDigestSubject(digest) {
  const count = digest.items.length;
  const noun = count === 1 ? 'comment' : 'comments';
  return `New tutorial feedback: ${count} ${noun}`;
}

/** Read the digest watermark (ISO string) from ImsConfig, or null when unset. */
export async function readFeedbackWatermark(db = cds.db) {
  const { ImsConfig } = cds.entities(NS);
  const row = await db.run(
    SELECT.one.from(ImsConfig).columns('value').where({ key: FEEDBACK_WATERMARK_KEY })
  );
  const v = row?.value;
  return v && String(v).trim() !== '' ? String(v) : null;
}

/**
 * Upsert the digest watermark. SELECT-then-UPDATE-or-INSERT because ImsConfig
 * has no unique constraint the DB can MERGE on. Sets ID explicitly:
 * INSERT.into on cds.db does NOT auto-fill a UUID key on HANA.
 */
export async function writeFeedbackWatermark(db, iso) {
  const { ImsConfig } = cds.entities(NS);
  const existing = await db.run(
    SELECT.one.from(ImsConfig).columns('ID').where({ key: FEEDBACK_WATERMARK_KEY })
  );
  if (existing) {
    await db.run(UPDATE(ImsConfig, existing.ID).set({ value: iso }));
  } else {
    await db.run(INSERT.into(ImsConfig).entries({ ID: cds.utils.uuid(), key: FEEDBACK_WATERMARK_KEY, value: iso }));
  }
}

/**
 * Daily digest cycle. Gated (prod + DB flag); when inactive returns
 * {active:false} and touches nothing. When active, emails each resolvable
 * owner their commented feedback since the last run and advances the watermark.
 *
 * Dependencies are injected so the cycle is testable under the real cds.test
 * serve harness without mocking SMTP or the whole boot:
 * @param {string|null} logId          PipelineLog id (scheduler passes it; may be null).
 * @param {object} [deps]
 * @param {object} [deps.db]           db connection (default cds.db).
 * @param {string} [deps.vcap]         VCAP_APPLICATION override (tests).
 * @param {Function} [deps.sendEmail]  send fn (default mail-client.sendNotificationEmail).
 * @param {string} [deps.dashboardUrl] dashboard base URL for the email footer.
 * @returns {Promise<{active:boolean, sent?:number, skipped?:number, failed?:number, total?:number}>}
 */
export async function sendFeedbackDigests(logId, deps = {}) {
  const db = deps.db || cds.db || await cds.connect.to('db');
  const sendEmail = deps.sendEmail || sendNotificationEmail;
  const LOG = cds.log('feedback-digest');

  if (!(await isFeedbackEmailActive(db, deps.vcap))) {
    LOG.info('Owner-feedback email inactive (env/flag gate) — skipping');
    return { active: false };
  }

  const runStart = new Date().toISOString();
  // First active run has no watermark → since=runStart → empty window, no
  // backlog blast. The watermark is seeded below for the next run.
  const watermark = await readFeedbackWatermark(db);
  const since = watermark || runStart;

  const digests = await computeFeedbackDigests({ since, until: runStart }, db);

  let sent = 0, skipped = 0, failed = 0;
  for (const d of digests) {
    if (!d.email) {
      // Unresolved owner — cannot email. Count + move on; the watermark still
      // advances so we don't re-scan this forever.
      skipped += d.items.length;
      LOG.warn(`Feedback for ${d.items.length} item(s) has no resolvable owner — not emailed`);
      continue;
    }
    const result = await sendEmail({
      to: d.email,
      subject: feedbackDigestSubject(d),
      template: 'feedback-digest',
      variables: {
        ownerName: d.name || 'Tutorial owner',
        feedbackCount: d.items.length,
        feedbackListHtml: renderFeedbackList(d.items),
        dashboardUrl: deps.dashboardUrl || '',
      },
    });
    if (result?.success) sent += 1;
    else failed += 1; // sendNotificationEmail queued it in FailedEmails already.
  }

  // Advance the watermark unconditionally once past the gate: failed sends are
  // queued for retry by mail-client, so re-scanning the same window would
  // double-send on the next run.
  await writeFeedbackWatermark(db, runStart);

  LOG.info(`Feedback digest: ${digests.length} owner(s), sent ${sent}, failed ${failed}, skipped ${skipped}`);
  return { active: true, sent, skipped, failed, total: digests.length };
}
