import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
import { generateOsVariants } from './lib/os-variant-generator.js';
import { createRateLimiter, RateLimitError } from './lib/chat-rate-limit.js';

const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'];
const OS_VARIANTS_LIMIT = 60;             // calls per hour per author
const OS_VARIANTS_WINDOW_MS = 60 * 60 * 1000;
const osVariantsLimiter = createRateLimiter({ windowMs: OS_VARIANTS_WINDOW_MS });

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

  this.on('generateOsVariants', async (req) => {
    const { sourceMarkdown, sourceOS, targetOSes, context } = req.data;
    const userId = req.user?.id ?? 'anonymous';

    if (!sourceMarkdown || typeof sourceMarkdown !== 'string' || sourceMarkdown.length === 0 || sourceMarkdown.length > 8000) {
      return req.reject(400, 'sourceMarkdown must be 1..8000 chars');
    }
    if (!OS_VALUES.includes(sourceOS)) return req.reject(400, 'invalid sourceOS');
    if (!Array.isArray(targetOSes) || targetOSes.length === 0 || targetOSes.length > 3) {
      return req.reject(400, 'targetOSes must be a non-empty array of length 1..3');
    }
    const seen = new Set();
    for (const t of targetOSes) {
      if (!OS_VALUES.includes(t))   return req.reject(400, `invalid targetOS: ${t}`);
      if (t === sourceOS)           return req.reject(400, 'targetOSes cannot include sourceOS');
      if (seen.has(t))              return req.reject(400, `duplicate targetOS: ${t}`);
      seen.add(t);
    }

    try {
      osVariantsLimiter.check(userId, OS_VARIANTS_LIMIT);
    } catch (err) {
      if (err instanceof RateLimitError) {
        return req.reject(429, `Rate limit exceeded — retry after ${err.retryAfterSec}s`);
      }
      throw err;
    }

    return generateOsVariants({ sourceMarkdown, sourceOS, targetOSes, context: context ?? {}, userId });
  });

  this.on('isSlugAvailable', async (req) => {
    const { slug } = req.data;
    if (!slug || typeof slug !== 'string') {
      return req.reject(400, 'slug must be a non-empty string');
    }
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    // LOWER()-based case-insensitive match. Mirrors the publish-side upsert
    // shape in srv/lib/content-publish-session.js so this UX check uses the
    // same key space as @assert.unique.slug's enforcement at write time.
    const row = await SELECT.one.from(Tutorials)
      .columns('ID')
      .where`LOWER(slug) = ${slug.toLowerCase()}`;
    return !row;  // true = available
  });
});
