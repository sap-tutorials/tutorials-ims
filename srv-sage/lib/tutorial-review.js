// srv-sage/lib/tutorial-review.js
//
// Local re-export of the tutorial review/snooze helpers for AuthorSageService.
// Keeps srv-sage isolated from srv/ — no cross-module imports.
//
// At local dev the workspace package exposes the functions directly from
// packages/core (they are part of the @tutorials/core surface). At CF deploy
// the bundled core.bundle.mjs is used. The resolve-db-user shim already
// imports the bundle; we import the functions from core directly here.
//
// reviewTutorial / snoozeTutorial are standalone DB-write helpers with no
// dependency on AI, GitHub, or the credstore — safe to expose in srv-sage.
//
// (#task-4 — srv-sage handler helpers)

import cds from '@sap/cds';

/**
 * Mark a tutorial as reviewed: resets notificationNumber to 0, clears
 * notification dates, sets reviewedDate = now.
 *
 * @param {string} tutorialId — Tutorials.ID (UUID)
 * @returns {{ reviewedDate: string, notificationNumber: number }}
 */
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
    reviewedDate:         now,
    notificationNumber:   0,
    lastNotificationDate: null,
    firstNotificationDate: null,
  });
  return { reviewedDate: now, notificationNumber: 0 };
}

/**
 * Snooze review notifications for `days` days from now.
 *
 * @param {string} tutorialId — Tutorials.ID (UUID)
 * @param {number} days — integer 1..365
 * @returns {{ notificationDate: string, notificationNumber: number }}
 */
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
