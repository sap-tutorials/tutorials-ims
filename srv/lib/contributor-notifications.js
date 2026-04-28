import cds from '@sap/cds';

export async function computeStaleNotifications(staleDaysThreshold = 180) {
  const { Tutorials, TutorialMeta, TutorialContributors } = cds.entities('com.sap.developers.ims');
  const cutoffDate = new Date(Date.now() - staleDaysThreshold * 86400000).toISOString();

  const staleMeta = await SELECT.from(TutorialMeta)
    .where({ monitoredStatus: 'ACTIVE', reviewedDate: { '<': cutoffDate } });

  const notifications = [];
  for (const meta of staleMeta) {
    const tutorial = await SELECT.one.from(Tutorials, meta.tutorial_ID);
    if (!tutorial || tutorial.status !== 'ACTIVE') continue;

    const contributors = await SELECT.from(TutorialContributors)
      .where({ tutorial_ID: tutorial.ID });

    notifications.push({
      tutorialId: tutorial.ID,
      slug: tutorial.slug,
      title: tutorial.title,
      reviewedDate: meta.reviewedDate,
      notificationNumber: meta.notificationNumber + 1,
      contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role }))
    });
  }

  return notifications;
}

export async function markNotificationSent(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) return;
  await UPDATE(TutorialMeta, meta.ID).set({
    notificationNumber: (meta.notificationNumber || 0) + 1,
    lastNotificationDate: new Date().toISOString()
  });
}
