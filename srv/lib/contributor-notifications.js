import cds from '@sap/cds';

const STALE_DAYS_DEFAULT = 90;
const RESEND_INTERVAL_DAYS = 30;
const MAX_NOTIFICATION_LEVEL = 3;
const USE_DIGEST_DEFAULT = true;
const LAST_CHANCE_MIN_LEVEL_DEFAULT = 3;
const LAST_CHANCE_DORMANCY_DAYS_DEFAULT = 60;

const TIMING_KNOBS = [
  { key: 'staleDaysThreshold',     field: 'staleDays',              type: 'int',  defaultValue: STALE_DAYS_DEFAULT },
  { key: 'resendIntervalDays',     field: 'resendIntervalDays',     type: 'int',  defaultValue: RESEND_INTERVAL_DAYS },
  { key: 'maxNotificationLevel',   field: 'maxLevel',               type: 'int',  defaultValue: MAX_NOTIFICATION_LEVEL },
  { key: 'useDigestNotifications', field: 'useDigest',              type: 'bool', defaultValue: USE_DIGEST_DEFAULT },
  { key: 'lastChanceMinLevel',     field: 'lastChanceMinLevel',     type: 'int',  defaultValue: LAST_CHANCE_MIN_LEVEL_DEFAULT },
  { key: 'lastChanceDormancyDays', field: 'lastChanceDormancyDays', type: 'int',  defaultValue: LAST_CHANCE_DORMANCY_DAYS_DEFAULT },
];

/**
 * Resolve timing knobs from ImsConfig. Type-aware: int knobs require a
 * positive integer; bool knobs accept only "true"/"false" (case-insensitive).
 * Invalid non-empty values WARN + fall back to default; missing rows fall
 * back silently.
 */
export async function resolveTimingKnobs() {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const out = {};
  for (const { key, field, type, defaultValue } of TIMING_KNOBS) {
    const row = await SELECT.one.from(ImsConfig).where({ key });
    const raw = row?.value;
    out[field] = parseKnob(key, raw, type, defaultValue);
  }
  return out;
}

function parseKnob(key, raw, type, defaultValue) {
  if (raw == null || raw === '') return defaultValue;
  if (type === 'bool') {
    const lc = String(raw).toLowerCase();
    if (lc === 'true') return true;
    if (lc === 'false') return false;
    console.warn(`[contributor-notifications] ImsConfig.${key}="${raw}" is not "true"/"false"; using default ${defaultValue}`);
    return defaultValue;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  console.warn(`[contributor-notifications] ImsConfig.${key}="${raw}" is not a positive integer; using default ${defaultValue}`);
  return defaultValue;
}

export async function computeStaleNotifications(optsOrStaleDays = {}) {
  // Backward-compat: callers pre-#545 pass a single number (staleDays). Newer
  // callers pass an opts object with all 3 knobs. Coerce both shapes here.
  const opts = typeof optsOrStaleDays === 'number'
    ? { staleDays: optsOrStaleDays }
    : optsOrStaleDays;
  const staleDaysThreshold = opts.staleDays ?? STALE_DAYS_DEFAULT;
  const resendIntervalDays = opts.resendIntervalDays ?? RESEND_INTERVAL_DAYS;
  const maxLevel = opts.maxLevel ?? MAX_NOTIFICATION_LEVEL;
  const { Tutorials, TutorialMeta, TutorialContributors } =
    cds.entities('com.sap.developers.ims');

  const cutoffDate = new Date(Date.now() - staleDaysThreshold * 86400000).toISOString();
  const resendCutoff = new Date(Date.now() - resendIntervalDays * 86400000).toISOString();

  const allActive = await SELECT.from(TutorialMeta).where({
    monitoredStatus: 'ACTIVE',
    reviewedDate: { '<': cutoffDate },
    notificationNumber: { '<=': maxLevel }
  });

  const staleMeta = allActive.filter(m =>
    !m.lastNotificationDate || m.lastNotificationDate < resendCutoff
  );

  const notifications = [];
  for (const meta of staleMeta) {
    const tutorial = await SELECT.one.from(Tutorials, meta.tutorial_ID);
    if (!tutorial || tutorial.status !== 'ACTIVE') continue;

    const contributors = await SELECT.from(TutorialContributors)
      .where({ tutorial_ID: tutorial.ID });

    // #385 PR-1: repo-group owner now lives on TutorialMeta.repository.repositoryOwner.
    // 2-level Association chain compiles to a LEFT JOIN on HANA. NULL-safe — if
    // meta.repository is null (no group assigned yet — common until PR-2 migrator
    // runs), the chain returns { email: null } and notification level 1 falls
    // through to owner-only recipients (existing behaviour).
    const repoOwnerRow = await SELECT.one.from(TutorialMeta)
      .columns('repository.repositoryOwner.email as email')
      .where({ tutorial_ID: tutorial.ID });

    notifications.push({
      tutorialId: tutorial.ID,
      slug: tutorial.slug,
      title: tutorial.title,
      reviewedDate: meta.reviewedDate,
      notificationLevel: meta.notificationNumber || 0,
      contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role })),
      repoOwner: repoOwnerRow?.email ?? null
    });
  }

  return notifications;
}

export function determineRecipients(notification, adminEmails = []) {
  const level = notification.notificationLevel;
  const owner = notification.contributors.find(c => c.role === 'OWNER')
    || notification.contributors.find(c => c.role === 'AUTHOR');
  const repoOwner = notification.repoOwner;

  switch (level) {
    case 0: return { to: [owner?.email].filter(Boolean), cc: [] };
    case 1: return { to: [owner?.email].filter(Boolean), cc: [repoOwner].filter(Boolean) };
    case 2: return { to: [owner?.email].filter(Boolean), cc: [repoOwner, ...adminEmails].filter(Boolean) };
    case 3: return { to: [...adminEmails].filter(Boolean), cc: [] };
    default: return { to: [], cc: [] };
  }
}

export async function markNotificationSent(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) return;
  const now = new Date().toISOString();
  const isFirstNag = !meta.notificationNumber;
  await UPDATE(TutorialMeta, meta.ID).set({
    notificationNumber: (meta.notificationNumber || 0) + 1,
    lastNotificationDate: now,
    // #450: set firstNotificationDate ONLY on the first nag. The
    // spread-conditional pattern keeps the UPDATE atomic and avoids
    // overwriting on subsequent nags.
    ...(isFirstNag && { firstNotificationDate: now }),
  });
}

export async function getAdminEmailList() {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const config = await SELECT.one.from(ImsConfig).where({ key: 'emailListForOutdated' });
  if (!config?.value) return [];
  return config.value.split(',').map(e => e.trim()).filter(Boolean);
}

export async function isNotificationsEnabled() {
  const { ImsConfig } = cds.entities('com.sap.developers.ims');
  const config = await SELECT.one.from(ImsConfig).where({ key: 'isNotificationSendingAllowed' });
  return config?.value === 'true';
}

/**
 * HTML-escape a string for safe embedding in attribute or text contexts.
 * Defense-in-depth — tutorial titles come from controlled sources, but
 * the cost is negligible.
 */
export function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Pre-render the per-tutorial <ul> for digest + last-chance emails.
 * Returns the HTML string for substitution as ${tutorialListHtml}.
 * Avoids extending resolveTemplate() to support iteration.
 *
 * @param {Array<{title:string, slug:string, reviewedDate:string|Date|null}>} tutorials
 *   reviewedDate is normally an ISO timestamp string from CDS, but a JS Date
 *   instance is also accepted (normalized via .toISOString()).
 * @param {string} dashboardUrl
 * @returns {string}
 */
export function renderTutorialList(tutorials, dashboardUrl) {
  const safeDashboardUrl = escapeHtml(dashboardUrl);
  const items = tutorials.map(t => {
    const title = escapeHtml(t.title);
    const slug = encodeURIComponent(t.slug);
    let date = '—';
    if (t.reviewedDate) {
      const iso = t.reviewedDate instanceof Date
        ? t.reviewedDate.toISOString()
        : String(t.reviewedDate);
      date = iso.slice(0, 10);
    }
    return `<li><a href="${safeDashboardUrl}#/tutorial/${slug}">${title}</a> — last reviewed ${date}</li>`;
  });
  return `<ul>${items.join('')}</ul>`;
}

/**
 * Build the subject line for a digest email. Levels 0-2 use the
 * "need review" wording; level 3 escalates to "FINAL NOTICE: pending
 * retirement". Pluralizes noun + verb.
 */
export function digestSubject(digest) {
  const count = digest.tutorials.length;
  const noun = count === 1 ? 'tutorial' : 'tutorials';
  if (digest.worstLevel === 3) {
    return `FINAL NOTICE: ${count} stale ${noun} pending retirement`;
  }
  const verb = count === 1 ? 'needs' : 'need';
  return `${count} stale ${noun} ${verb} review`;
}
