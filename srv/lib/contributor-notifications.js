import cds from '@sap/cds';

const STALE_DAYS_DEFAULT = 180;
const RESEND_INTERVAL_DAYS = 30;
const MAX_NOTIFICATION_LEVEL = 3;

export async function computeStaleNotifications(staleDaysThreshold = STALE_DAYS_DEFAULT) {
  const { Tutorials, TutorialMeta, TutorialContributors, TutorialRepositories } =
    cds.entities('com.sap.developers.ims');

  const cutoffDate = new Date(Date.now() - staleDaysThreshold * 86400000).toISOString();
  const resendCutoff = new Date(Date.now() - RESEND_INTERVAL_DAYS * 86400000).toISOString();

  const allActive = await SELECT.from(TutorialMeta).where({
    monitoredStatus: 'ACTIVE',
    reviewedDate: { '<': cutoffDate },
    notificationNumber: { '<=': MAX_NOTIFICATION_LEVEL }
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

    const repo = await SELECT.one.from(TutorialRepositories)
      .where({ tutorial_ID: tutorial.ID });

    notifications.push({
      tutorialId: tutorial.ID,
      slug: tutorial.slug,
      title: tutorial.title,
      reviewedDate: meta.reviewedDate,
      notificationLevel: meta.notificationNumber || 0,
      contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role })),
      repoOwner: repo?.owner || null
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
