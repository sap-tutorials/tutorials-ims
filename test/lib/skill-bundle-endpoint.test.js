import { describe, it, expect } from 'vitest';
import { Writable } from 'node:stream';
import JSZip from 'jszip';
import { createSkillBundleHandler } from '../../srv/lib/skill-bundle.js';

// Collect the streamed zip into a buffer via a fake res that is a Writable.
function fakeRes() {
  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.statusCode = 200;
  res.headers = {};
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.jsonBody = b; res.end(); return res; };
  res.buffer = () => Buffer.concat(chunks);
  return res;
}
const req = (slug) => ({ params: { slug } });

const baseDeps = {
  isFlagEnabled: () => true,
  getTutorialSource: async () => ({ markdown: `---\ntitle: T\ndescription: D\n---\n\n## Step 1\nBody.\n` }),
  loadAssertSpecs: async () => [{ stepNumber: 1, assertIndex: 0, type: 'cmd', run: 'x', expectExit: 0 }],
  buildFreshnessStamp: async () => ({ confidence: 'high', lastVerified: '2026-09-01', sourceCommit: 'abc', jws: null }),
  provenanceFlagKey: 'PROVENANCE_ENVELOPE_ENABLED',
};

describe('skill bundle handler', () => {
  it('404 when feature flag is off', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, isFlagEnabled: () => false })(req('t'), res);
    expect(res.statusCode).toBe(404);
  });

  it('404 when the slug has no source markdown', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, getTutorialSource: async () => ({ markdown: null }) })(req('nope'), res);
    expect(res.statusCode).toBe(404);
  });

  it('200 streams a zip with SKILL.md and verify.sh', async () => {
    const res = fakeRes();
    await createSkillBundleHandler(baseDeps)(req('my-tutorial'), res);
    await new Promise((r) => res.on('finish', r));
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('my-tutorial-skill.zip');
    const zip = await JSZip.loadAsync(res.buffer());
    expect(zip.file('my-tutorial/SKILL.md')).toBeTruthy();
    const verify = await zip.file('my-tutorial/verify.sh').async('string');
    expect(verify).toContain('#!/usr/bin/env bash');
    expect(verify).toContain("'x'");
    const skill = await zip.file('my-tutorial/SKILL.md').async('string');
    expect(skill).toContain('name: my-tutorial');
    expect(skill).toContain('confidence: high');
  });

  it('301 redirect when slug is non-canonical (mixed case)', async () => {
    const res = fakeRes();
    await createSkillBundleHandler(baseDeps)(req('My-Tutorial'), res);
    expect(res.statusCode).toBe(301);
    expect(res.headers['location']).toContain('my-tutorial');
    expect(res.headers['location']).toMatch(/\/skill$/);
  });

  it('still ships (degraded) when provenance/asserts are empty', async () => {
    const res = fakeRes();
    await createSkillBundleHandler({ ...baseDeps, loadAssertSpecs: async () => [], buildFreshnessStamp: async () => ({ confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null }) })(req('t'), res);
    await new Promise((r) => res.on('finish', r));
    const zip = await JSZip.loadAsync(res.buffer());
    const verify = await zip.file('t/verify.sh').async('string');
    expect(verify).toContain('No automated checks defined');
  });
});
