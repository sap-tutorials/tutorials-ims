// test/unit/srv/jobs/gc-external-content-iteration-set.test.js
import { describe, it, expect } from 'vitest';
import { ITERATION_SET } from '../../../../srv/jobs/gc-external-content-job.js';

describe('gc-external-content ITERATION_SET', () => {
  it('includes all 8 external-content types (through Phase 4.8)', () => {
    expect(Object.keys(ITERATION_SET).sort()).toEqual([
      'api-doc',
      'blog-post',
      'community-event',
      'discovery-mission',
      'help-doc',
      'learning-journey',
      'sample',
      'video',
    ]);
  });

  it('maps community-event to CommunityEvents entity', () => {
    expect(ITERATION_SET['community-event']).toBe('CommunityEvents');
  });
});
