import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';

async function assertOwnership(tutorialId, userId) {
  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  const row = await SELECT.one.from(MyTutorialsView)
    .columns('ID')
    .where({ ID: tutorialId, ownerUserId: userId });
  return !!row;
}

export default cds.service.impl(async function () {
  const { MyTutorials } = this.entities;

  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') return req.reject(401, 'Authentication required');
    req.query.where({ ownerUserId: userId });
  });

  this.on('reviewTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId } = req.data;
    if (!(await assertOwnership(tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await reviewTutorial(tutorialId);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });

  this.on('snoozeTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId, days } = req.data;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return req.reject(400, 'days must be an integer in [1, 365]');
    }
    if (!(await assertOwnership(tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await snoozeTutorial(tutorialId, days);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });
});
