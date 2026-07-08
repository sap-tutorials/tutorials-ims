// test/unit/community-blogs-classifier.test.js
//
// (#1033) Unit tests for the classifier drain. Uses the classifyOne
// clientOverride seam to inject a fake OrchestrationClient whose
// chatCompletion returns canned responses — matching the pattern in
// test/unit/category-classifier-llm.test.js.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import cds from '@sap/cds';
import {
  classifyOne,
  classifyPendingBatch,
  isClassifierEnabled,
} from '../../srv/lib/community-blogs-classifier.js';

cds.test('serve', '--project', '.', '--in-memory');

// Fake OrchestrationClient — returns whatever the test seeded via `mockNext`.
function makeFakeClient(mockNext) {
  return {
    async chatCompletion() {
      const next = mockNext();
      if (next instanceof Error) throw next;
      return {
        getToolCalls: () => next.toolCalls ?? [],
        getTokenUsage: () => null,
      };
    },
  };
}

function toolCall({ verdict, confidence, reason }) {
  return [{
    function: {
      name: 'submit_verdict',
      arguments: JSON.stringify({ verdict, confidence, reason }),
    },
  }];
}

// -----------------------------------------------------------------------------

describe('isClassifierEnabled', () => {
  const orig = process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
  afterAll(() => {
    // Restore env so the next describe doesn't inherit our last-test setting.
    if (orig === undefined) delete process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
    else process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = orig;
  });

  it('enabled by default (env unset)', () => {
    delete process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
    expect(isClassifierEnabled()).toBe(true);
  });
  it('enabled when set to "true"', () => {
    process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = 'true';
    expect(isClassifierEnabled()).toBe(true);
  });
  it('disabled when set to "false"', () => {
    process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = 'false';
    expect(isClassifierEnabled()).toBe(false);
  });
});

// -----------------------------------------------------------------------------

describe('classifyOne', () => {
  const row = {
    title: 'Building a CAP service in TypeScript',
    author: 'Jane Dev',
    descriptionSnippet: 'A walkthrough of a hands-on build with code samples.',
    attemptCount: 0,
  };

  it('returns DEVELOPER_RELEVANT verdict from a well-formed tool call', async () => {
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'DEVELOPER_RELEVANT', confidence: 0.92, reason: 'has code' }),
    }));
    const result = await classifyOne(row, { clientOverride: client });
    expect(result.aiVerdict).toBe('DEVELOPER_RELEVANT');
    expect(result.aiConfidence).toBeCloseTo(0.92, 3);
    expect(result.aiReason).toBe('has code');
    expect(result.attemptCount).toBe(1);
  });

  it('returns ERROR with parse reason when tool call missing', async () => {
    const client = makeFakeClient(() => ({ toolCalls: [] }));
    const result = await classifyOne(row, { clientOverride: client });
    expect(result.aiVerdict).toBe('ERROR');
    expect(result.aiReason).toBe('parse: no tool call');
    expect(result.attemptCount).toBe(1);
  });

  it('returns ERROR with parse reason for bad verdict enum', async () => {
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'MAYBE', confidence: 0.5, reason: 'idk' }),
    }));
    const result = await classifyOne(row, { clientOverride: client });
    expect(result.aiVerdict).toBe('ERROR');
    expect(result.aiReason).toMatch(/^parse: bad verdict/);
  });

  it('returns ERROR with aicore reason when the client throws', async () => {
    const err = new Error('429 Too Many Requests');
    err.code = 429;
    const client = makeFakeClient(() => err);
    const result = await classifyOne(row, { clientOverride: client });
    expect(result.aiVerdict).toBe('ERROR');
    expect(result.aiReason).toMatch(/^aicore:/);
  });

  it('clamps confidence to [0,1]', async () => {
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'NOT_RELEVANT', confidence: 1.7, reason: 'x' }),
    }));
    const result = await classifyOne(row, { clientOverride: client });
    expect(result.aiConfidence).toBe(1);
  });

  it('advances attemptCount from prior value', async () => {
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'DEVELOPER_RELEVANT', confidence: 0.8, reason: 'x' }),
    }));
    const result = await classifyOne({ ...row, attemptCount: 1 }, { clientOverride: client });
    expect(result.attemptCount).toBe(2);
  });
});

// -----------------------------------------------------------------------------

describe('classifyPendingBatch', () => {
  let db, CommunityBlogPosts, sourceId;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    CommunityBlogPosts = cds.entities('com.sap.developers.ims').CommunityBlogPosts;
    const source = await db.run(
      SELECT.one.from(cds.entities('com.sap.developers.ims').CommunityBlogSources)
        .where({ topicSlug: 'community-technology' })
    );
    sourceId = source.ID;
  });

  beforeEach(async () => {
    // Fresh state — nuke any test rows the previous case inserted.
    await db.run(DELETE.from(CommunityBlogPosts).where({ sourceId_ID: sourceId }));
  });

  it('drains PENDING rows and updates them to a real verdict', async () => {
    await db.run(INSERT.into(CommunityBlogPosts).entries([
      { ID: '00000000-0000-0000-0000-0000000000a1', sourceUrl: 'https://x/pend-1', sourceId_ID: sourceId, title: 'A', aiVerdict: 'PENDING' },
      { ID: '00000000-0000-0000-0000-0000000000a2', sourceUrl: 'https://x/pend-2', sourceId_ID: sourceId, title: 'B', aiVerdict: 'PENDING' },
    ]));
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'DEVELOPER_RELEVANT', confidence: 0.9, reason: 'good' }),
    }));
    const summary = await classifyPendingBatch({ clientOverride: client, limit: 10 });
    expect(summary.drained).toBe(2);
    expect(summary.ok).toBe(2);

    const updated = await db.run(SELECT.from(CommunityBlogPosts)
      .where({ sourceId_ID: sourceId })
      .columns('aiVerdict'));
    expect(updated.every(r => r.aiVerdict === 'DEVELOPER_RELEVANT')).toBe(true);
  });

  it('respects the batch limit', async () => {
    await db.run(INSERT.into(CommunityBlogPosts).entries([
      { ID: '00000000-0000-0000-0000-0000000000b1', sourceUrl: 'https://x/pend-3', sourceId_ID: sourceId, title: 'A', aiVerdict: 'PENDING' },
      { ID: '00000000-0000-0000-0000-0000000000b2', sourceUrl: 'https://x/pend-4', sourceId_ID: sourceId, title: 'B', aiVerdict: 'PENDING' },
      { ID: '00000000-0000-0000-0000-0000000000b3', sourceUrl: 'https://x/pend-5', sourceId_ID: sourceId, title: 'C', aiVerdict: 'PENDING' },
    ]));
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'DEVELOPER_RELEVANT', confidence: 0.9, reason: 'good' }),
    }));
    const summary = await classifyPendingBatch({ clientOverride: client, limit: 2 });
    expect(summary.drained).toBe(2);
    const stillPending = await db.run(SELECT.from(CommunityBlogPosts)
      .where({ sourceId_ID: sourceId, aiVerdict: 'PENDING' }));
    expect(stillPending.length).toBe(1);
  });

  it('re-picks ERROR rows with attemptCount<2, skips attemptCount=2', async () => {
    await db.run(INSERT.into(CommunityBlogPosts).entries([
      { ID: '00000000-0000-0000-0000-0000000000c1', sourceUrl: 'https://x/err-1', sourceId_ID: sourceId, title: 'A', aiVerdict: 'ERROR', attemptCount: 1 },
      { ID: '00000000-0000-0000-0000-0000000000c2', sourceUrl: 'https://x/err-2', sourceId_ID: sourceId, title: 'B', aiVerdict: 'ERROR', attemptCount: 2 },
    ]));
    const client = makeFakeClient(() => ({
      toolCalls: toolCall({ verdict: 'DEVELOPER_RELEVANT', confidence: 0.9, reason: 'good' }),
    }));
    const summary = await classifyPendingBatch({ clientOverride: client, limit: 10 });
    expect(summary.drained).toBe(1);  // only the attemptCount=1 row
    const rows = await db.run(SELECT.from(CommunityBlogPosts)
      .where({ sourceId_ID: sourceId })
      .orderBy('title'));
    expect(rows.find(r => r.title === 'A').aiVerdict).toBe('DEVELOPER_RELEVANT');
    expect(rows.find(r => r.title === 'B').aiVerdict).toBe('ERROR');
  });

  it('returns disabled:true when kill switch is on', async () => {
    const orig = process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
    process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = 'false';
    try {
      const summary = await classifyPendingBatch({ limit: 10 });
      expect(summary.disabled).toBe(true);
      expect(summary.drained).toBe(0);
    } finally {
      if (orig === undefined) delete process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED;
      else process.env.COMMUNITY_BLOGS_CLASSIFIER_ENABLED = orig;
    }
  });
});
