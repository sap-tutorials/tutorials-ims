// test/unit/mcp-admin-tools.test.js
// Phase 3 (#1106) — admin curation MCP tool handlers.
// Asserts each handler DELEGATES to the wrapped action/logic, not reimplements it.
import { expect, describe, it, vi } from 'vitest';
import {
  handleMergeConcepts, handlePromoteCommunity,
  handleTriggerRebuild, handlePublishContent,
} from '../../srv/lib/mcp-admin-tools.js';

describe('mcp-admin-tools', () => {
  it('merge_concepts delegates to KnowledgeGraphService.mergeConcepts', async () => {
    const kg = { send: vi.fn(async () => ({})) };
    const connectSpy = vi.fn(async () => kg);
    const out = await handleMergeConcepts.call({}, {
      data: { loser: 'L', canonical: 'C' },
      _connect: connectSpy,
    });
    expect(connectSpy).toHaveBeenCalledWith('KnowledgeGraphService');
    expect(kg.send).toHaveBeenCalledWith('mergeConcepts', { loser: 'L', canonical: 'C' });
    expect(out).toEqual({ merged: true, loser: 'L', canonical: 'C' });
  });

  it('promote_community_to_mission delegates to the service\'s own promoteCommunityToMission action', async () => {
    const srv = { send: vi.fn(async () => ({ ID: 'mission-uuid', slug: 'my-mission' })) };
    const out = await handlePromoteCommunity.call(srv, {
      data: { communityId: 42, missionSlug: 'my-mission', title: 'My Mission' },
    });
    expect(srv.send).toHaveBeenCalledWith('promoteCommunityToMission', {
      communityId: 42, missionSlug: 'my-mission', title: 'My Mission',
    });
    expect(out.ID).toBe('mission-uuid');
  });

  it('promote_community_to_mission lets the underlying action reject propagate (no swallow)', async () => {
    const err = Object.assign(new Error('no tutorial members'), { code: 404 });
    const srv = { send: vi.fn(async () => { throw err; }) };
    await expect(handlePromoteCommunity.call(srv, {
      data: { communityId: 1, missionSlug: 's', title: 't' },
    })).rejects.toThrow('no tutorial members');
  });

  it('trigger_rebuild calls scheduleRebuild with mode+slug', async () => {
    const scheduleSpy = vi.fn(async () => ({ scheduled: true }));
    const out = await handleTriggerRebuild.call({}, {
      data: { slug: 'foo', mode: 'slug-targeted' },
      user: { id: 'author@sap.example' },
      _schedule: scheduleSpy,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.stringContaining('mcp'),
      { mode: 'slug-targeted', slug: 'foo' },
    );
    expect(out).toEqual({ scheduled: true, mode: 'slug-targeted', slug: 'foo' });
  });

  it('trigger_rebuild infers slug-targeted mode when slug set and mode omitted', async () => {
    const scheduleSpy = vi.fn(async () => ({}));
    const out = await handleTriggerRebuild.call({}, {
      data: { slug: 'foo' }, user: { id: 'a' }, _schedule: scheduleSpy,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(expect.any(String), { mode: 'slug-targeted', slug: 'foo' });
    expect(out.mode).toBe('slug-targeted');
    expect(out.slug).toBe('foo');
  });

  it('trigger_rebuild infers full mode when no slug given', async () => {
    const scheduleSpy = vi.fn(async () => ({}));
    const out = await handleTriggerRebuild.call({}, {
      data: {}, user: { id: 'a' }, _schedule: scheduleSpy,
    });
    expect(scheduleSpy).toHaveBeenCalledWith(expect.any(String), { mode: 'full', slug: null });
    expect(out.mode).toBe('full');
    expect(out.slug).toBe(null);
  });

  it('publish_content invokes the content-store publishHandler via a synthetic req/res (no reimplementation)', async () => {
    // Inject a fake publishHandler factory so we assert delegation, not the
    // real content-store DB path. The handler must build a single-slug body
    // and pass it through the existing validation/guards.
    const saved = process.env.CONTENT_API_KEY;
    process.env.CONTENT_API_KEY = 'test-key';
    try {
      const publishHandler = vi.fn(async (req, res) => {
        expect(req.body.files).toHaveProperty('my-slug');
        res.status(201).json({ version: 7, filesWritten: 1 });
      });
      const factory = vi.fn(() => ({ publishHandler }));
      const out = await handlePublishContent.call({}, {
        data: { slug: 'my-slug', html: 'PGh0bWw+' },
        user: { id: 'author@sap.example' },
        _createContentHandlers: factory,
      });
      expect(publishHandler).toHaveBeenCalledTimes(1);
      expect(out.published).toBe(true);
      expect(out.slug).toBe('my-slug');
    } finally {
      if (saved === undefined) delete process.env.CONTENT_API_KEY;
      else process.env.CONTENT_API_KEY = saved;
    }
  });

  it('publish_content rejects when publishHandler returns a 4xx/5xx status', async () => {
    const saved = process.env.CONTENT_API_KEY;
    process.env.CONTENT_API_KEY = 'test-key';
    try {
      const publishHandler = vi.fn(async (req, res) => {
        res.status(400).json({ error: 'bad payload' });
      });
      const factory = vi.fn(() => ({ publishHandler }));
      const reject = vi.fn((code, msg) => { throw Object.assign(new Error(msg), { code }); });
      await expect(handlePublishContent.call({}, {
        data: { slug: 'my-slug', html: 'PGh0bWw+' },
        user: { id: 'a' },
        reject,
        _createContentHandlers: factory,
      })).rejects.toThrow('bad payload');
      expect(reject).toHaveBeenCalledWith(400, 'bad payload');
    } finally {
      if (saved === undefined) delete process.env.CONTENT_API_KEY;
      else process.env.CONTENT_API_KEY = saved;
    }
  });

  it('publish_content rejects with 503 when CONTENT_API_KEY is not set', async () => {
    const saved = process.env.CONTENT_API_KEY;
    delete process.env.CONTENT_API_KEY;
    try {
      const reject = vi.fn((code, msg) => { throw Object.assign(new Error(msg), { code }); });
      await expect(handlePublishContent.call({}, {
        data: { slug: 'my-slug', html: 'PGh0bWw+' },
        user: { id: 'a' },
        reject,
      })).rejects.toThrow('CONTENT_API_KEY not configured');
      expect(reject).toHaveBeenCalledWith(503, expect.stringContaining('CONTENT_API_KEY not configured'));
    } finally {
      if (saved !== undefined) process.env.CONTENT_API_KEY = saved;
    }
  });
});
