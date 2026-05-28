// srv/lib/my-progress-handler.js
import cds from '@sap/cds';
import { getUserProgress } from './user-progress.js';

const LOG = cds.log('navigator');

const EMPTY_PAYLOAD = Object.freeze({
  authenticated: false,
  tutorials: { completedSlugs: [], inProgress: [] },
  missionSlugs: [],
  groupSlugs: []
});

export async function myProgressHandler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  const user = req.user || cds.context?.user;
  const isAnonymous = !user?.id || user.id === 'anonymous';

  if (isAnonymous) {
    return res.status(200).json(EMPTY_PAYLOAD);
  }

  try {
    const progress = await getUserProgress(user, { limit: 25 });
    const inProgress = progress.inProgress
      .filter(t => typeof t.progressPercent === 'number' && t.progressPercent > 0)
      .map(t => ({ slug: t.slug, progressPercent: t.progressPercent }));

    return res.status(200).json({
      authenticated: true,
      tutorials: {
        completedSlugs: progress.completedSlugs,
        inProgress
      },
      missionSlugs: progress.completedMissionSlugs,
      groupSlugs: progress.completedGroupSlugs
    });
  } catch (err) {
    LOG.warn('my-progress handler failed', err.message);
    return res.status(200).json(EMPTY_PAYLOAD);
  }
}
