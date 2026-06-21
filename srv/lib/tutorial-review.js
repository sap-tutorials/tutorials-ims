import cds from '@sap/cds';

export async function reviewTutorial(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) {
    const err = new Error(`TutorialMeta not found for tutorial: ${tutorialId}`);
    err.code = 404;
    throw err;
  }
  const now = new Date().toISOString();
  await UPDATE(TutorialMeta, meta.ID).set({
    reviewedDate: now,
    notificationNumber: 0,
    lastNotificationDate: null,
    firstNotificationDate: null
  });
  return { reviewedDate: now, notificationNumber: 0 };
}

export async function snoozeTutorial(tutorialId, days) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) {
    const err = new Error(`TutorialMeta not found for tutorial: ${tutorialId}`);
    err.code = 404;
    throw err;
  }
  const snoozeUntil = new Date(Date.now() + (days || 30) * 86400000).toISOString();
  await UPDATE(TutorialMeta, meta.ID).set({ lastNotificationDate: snoozeUntil });
  return { notificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
}
