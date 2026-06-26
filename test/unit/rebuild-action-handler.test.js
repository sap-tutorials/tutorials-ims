import { describe, it, expect, vi } from 'vitest';
import { handleRebuildAction } from '../../srv/lib/rebuild-action-handler.js';

describe('handleRebuildAction', () => {
  const tutorialId = '00000000-0000-0000-0000-000000000001';

  function makeReq({ slug = 'my-tutorial', userId = 'alice' } = {}) {
    return {
      params: [{ ID: tutorialId }],
      user: { id: userId },
      reject: vi.fn((code, msg) => ({ rejected: { code, msg } })),
    };
  }

  it('rejects when the tutorial has no slug', async () => {
    const req = makeReq();
    const selectOne = vi.fn().mockResolvedValue({ slug: null, title: 'X' });
    const audit = vi.fn();
    const schedule = vi.fn();
    await handleRebuildAction(req, {
      source: 'admin-ui:tutorial-detail',
      selectOne, audit, schedule,
    });
    expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/slug/));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('emits audit + dispatches with slug-targeted mode', async () => {
    const req = makeReq();
    const selectOne = vi.fn().mockResolvedValue({ slug: 'hello', title: 'Hello' });
    const audit = vi.fn().mockResolvedValue();
    const schedule = vi.fn().mockResolvedValue({ workflowUrl: 'https://gh/...' });

    const result = await handleRebuildAction(req, {
      source: 'author-ui:tutorial-detail',
      selectOne, audit, schedule,
    });

    expect(audit).toHaveBeenCalledWith('TutorialRebuildTriggered', {
      user: 'alice',
      tutorialId,
      slug: 'hello',
      source: 'author-ui:tutorial-detail',
    });
    expect(schedule).toHaveBeenCalledWith(
      'author-ui:rebuild-button:alice',
      { mode: 'slug-targeted', slug: 'hello' }
    );
    expect(result).toEqual({
      dispatched: true,
      slug: 'hello',
      debounced: expect.any(Boolean),
      workflowUrl: expect.any(String),
    });
  });

  it('defaults userId to "anonymous" when req.user is missing', async () => {
    // makeReq's destructuring default would re-assign userId to 'alice' if we
    // passed `{ userId: undefined }`, so build the bare req inline to actually
    // exercise the `req.user?.id ?? 'anonymous'` fallback.
    const req = {
      params: [{ ID: tutorialId }],
      reject: vi.fn((code, msg) => ({ rejected: { code, msg } })),
    };
    const selectOne = vi.fn().mockResolvedValue({ slug: 'x', title: 'X' });
    const audit = vi.fn().mockResolvedValue();
    const schedule = vi.fn().mockResolvedValue({});
    await handleRebuildAction(req, {
      source: 'admin-ui:tutorial-detail',
      selectOne, audit, schedule,
    });
    expect(audit).toHaveBeenCalledWith(
      'TutorialRebuildTriggered',
      expect.objectContaining({ user: 'anonymous' })
    );
  });
});
