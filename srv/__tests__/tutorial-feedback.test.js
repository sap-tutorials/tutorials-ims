// srv/__tests__/tutorial-feedback.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

describe('submitTutorialFeedback', () => {
  let srv;

  let nextIp = null;

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');
    // Simulate what the express bridge in Task 6 will do: inject _clientIp
    // into req.data before the action handler runs, bypassing CDS validation
    // which would reject unknown properties in the action payload itself.
    srv.before('submitTutorialFeedback', (req) => {
      if (nextIp != null) req.data._clientIp = nextIp;
    });

    const { ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentFiles).entries([
      { slug: 'demo-tutorial', version: 1 }
    ]);
  });

  afterAll(async () => {
    const { TutorialFeedback, ContentFiles } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialFeedback);
    await DELETE.from(ContentFiles).where({ slug: 'demo-tutorial' });
  });

  async function submit(payload) {
    const { _clientIp, ...rest } = payload;
    nextIp = _clientIp ?? null;
    try {
      const result = await srv.send({
        event: 'submitTutorialFeedback',
        data: rest
      });
      return { status: 200, data: result };
    } catch (e) {
      return { status: e.code ? Number(e.code) : 500, error: e };
    } finally {
      nextIp = null;
    }
  }

  it('persists a valid submission and returns a UUID submissionId', async () => {
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      ratingUseCase: 7,
      ratingRelevance: 8,
      ratingDuration: 5,
      ratingStructure: 6,
      ratingInteresting: 9,
      ratingVisuals: 4,
      npsScore: 10,
      comment: 'Great tutorial',
      wasAuthenticated: false,
      honeypot: '',
      _clientIp: '10.0.0.1'
    });

    expect(status).toBe(200);
    expect(data.submissionId).toMatch(/^[0-9a-f-]{36}$/i);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialFeedback).where({
      tutorialSlug: 'demo-tutorial'
    });
    expect(rows.length).toBe(1);
    expect(rows[0].npsScore).toBe(10);
    expect(rows[0].comment).toBe('Great tutorial');
  });

  it('rejects an unknown slug with 400', async () => {
    const { status } = await submit({
      tutorialSlug: 'does-not-exist',
      npsScore: 5,
      honeypot: '',
      _clientIp: '10.0.0.2'
    });

    expect(status).toBe(400);
  });

  it('returns 200 but does not persist when honeypot is filled', async () => {
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const before = await SELECT.from(TutorialFeedback);

    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 8,
      honeypot: 'i-am-a-bot',
      _clientIp: '10.0.0.3'
    });

    expect(status).toBe(200);
    expect(data.submissionId).toMatch(/^[0-9a-f-]{36}$/i);

    const after = await SELECT.from(TutorialFeedback);
    expect(after.length).toBe(before.length);
  });

  it('rejects ratings outside 0-10 with 400', async () => {
    const { status } = await submit({
      tutorialSlug: 'demo-tutorial',
      ratingUseCase: 11,
      honeypot: '',
      _clientIp: '10.0.0.4'
    });

    expect(status).toBe(400);
  });

  it('rate-limits a single IP after 5 submissions in an hour', async () => {
    const ip = '10.0.99.1';
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const { status } = await submit({
        tutorialSlug: 'demo-tutorial',
        npsScore: 7,
        honeypot: '',
        _clientIp: ip
      });
      statuses.push(status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('persists wasAuthenticated when true', async () => {
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 9,
      wasAuthenticated: true,
      honeypot: '',
      _clientIp: '10.0.0.5'
    });

    expect(status).toBe(200);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback)
      .where({ ID: data.submissionId });
    expect(row.wasAuthenticated).toBe(true);
  });

  it('rejects missing tutorialSlug with 400', async () => {
    const { status } = await submit({
      npsScore: 7,
      honeypot: '',
      _clientIp: '10.0.0.6'
    });

    expect(status).toBe(400);
  });

  it('accepts null ratings (skipped questions)', async () => {
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      ratingUseCase: null,
      ratingRelevance: null,
      ratingDuration: null,
      ratingStructure: null,
      ratingInteresting: null,
      ratingVisuals: null,
      npsScore: 8,
      honeypot: '',
      _clientIp: '10.0.0.7'
    });

    expect(status).toBe(200);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback)
      .where({ ID: data.submissionId });
    expect(row.ratingUseCase).toBeNull();
    expect(row.ratingRelevance).toBeNull();
    expect(row.npsScore).toBe(8);
  });

  it('truncates comments longer than 2000 chars', async () => {
    const longComment = 'x'.repeat(2500);
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 7,
      comment: longComment,
      honeypot: '',
      _clientIp: '10.0.0.8'
    });

    expect(status).toBe(200);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback)
      .where({ ID: data.submissionId });
    expect(row.comment.length).toBe(2000);
    expect(row.comment).toMatch(/^x+$/);
  });

  it('strips control characters from comments', async () => {
    const dirty = 'hello\x00\x01world\x07\x1F\x7Fend';
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 7,
      comment: dirty,
      honeypot: '',
      _clientIp: '10.0.0.9'
    });

    expect(status).toBe(200);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback)
      .where({ ID: data.submissionId });
    expect(row.comment).toBe('helloworldend');
  });

  it('preserves newlines and tabs in comments', async () => {
    const text = 'line1\nline2\tcol2\rline3';
    const { status, data } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 7,
      comment: text,
      honeypot: '',
      _clientIp: '10.0.0.10'
    });

    expect(status).toBe(200);

    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback)
      .where({ ID: data.submissionId });
    expect(row.comment).toBe(text);
  });

  it('rate limit is per-IP — different IPs do not share the bucket', async () => {
    // Exhaust IP A's bucket (5 submissions OK, 6th rejected)
    const ipA = '10.0.55.1';
    for (let i = 0; i < 5; i++) {
      const { status } = await submit({
        tutorialSlug: 'demo-tutorial',
        npsScore: 7,
        honeypot: '',
        _clientIp: ipA
      });
      expect(status).toBe(200);
    }
    const { status: limited } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 7,
      honeypot: '',
      _clientIp: ipA
    });
    expect(limited).toBe(429);

    // IP B starts fresh — first submission must succeed
    const ipB = '10.0.55.2';
    const { status: fresh } = await submit({
      tutorialSlug: 'demo-tutorial',
      npsScore: 7,
      honeypot: '',
      _clientIp: ipB
    });
    expect(fresh).toBe(200);
  });
});
