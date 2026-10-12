/**
 * #2727 — the render-pipeline token must survive a publish round-trip:
 *   1. commit records `pipelineToken` on the ACTIVE ContentManifest, and
 *   2. GET /content/hashes echoes it back as the `X-Pipeline-Token` header
 *      so the next publish can detect a parser/template/CSS change.
 *
 * Without this, a parser/template/CSS-only fix (identical source markdown)
 * is seen as a no-op and the stale HTML BLOB is carried forward (the trap
 * #2727 fixes). These tests exercise the SESSION publish path
 * (begin → append → commit), which is the path `scripts/publish-content.ts`
 * uses in CI.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';
const API_KEY = 'test-pipeline-token-key-2727';
const project = cds.test('serve', '--project', '.', '--in-memory');

function b64gzip(html) {
  return gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
}

describe('pipeline token round-trip (#2727)', () => {
  let helpers;
  let ContentFiles, ContentManifest, PipelineLog, JobLocks;

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, PipelineLog, JobLocks } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  async function publishWithToken(slug, html, pipelineToken) {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-2727', hugoVersion: '0.147.0', expectedSlugCount: 1, initiator: 'test'
    });
    await helpers.appendToSession({ sessionId, files: { [slug]: b64gzip(html) } });
    return helpers.commitSession({ sessionId, pipelineToken });
  }

  it('persists pipelineToken on the ACTIVE ContentManifest at commit', async () => {
    const token = 'a'.repeat(64);
    const { version } = await publishWithToken('tok-slug', '<html>v1</html>', token);
    const manifest = await SELECT.one.from(ContentManifest).where({ version });
    expect(manifest.status).toBe('ACTIVE');
    expect(manifest.pipelineToken).toBe(token);
  });

  it('leaves pipelineToken NULL when commit omits it (older client)', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-2727-legacy', hugoVersion: '0.147.0', expectedSlugCount: 1, initiator: 'test'
    });
    await helpers.appendToSession({ sessionId, files: { 'legacy-slug': b64gzip('<html>legacy</html>') } });
    const { version } = await helpers.commitSession({ sessionId }); // no pipelineToken
    const manifest = await SELECT.one.from(ContentManifest).where({ version });
    expect(manifest.pipelineToken ?? null).toBeNull();
  });

  it('echoes the active token on GET /content/hashes as X-Pipeline-Token', async () => {
    const token = 'b'.repeat(64);
    await publishWithToken('hdr-slug', '<html>hdr</html>', token);
    const res = await project.axios.get('/content/hashes', { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    expect(res.headers['x-pipeline-token']).toBe(token);
    // JSON body shape is unchanged — still a flat slug → hash map.
    expect(res.data['hdr-slug']).toBeTruthy();
  });

  it('omits the X-Pipeline-Token header when the active manifest has none', async () => {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-2727-nohdr', hugoVersion: '0.147.0', expectedSlugCount: 1, initiator: 'test'
    });
    await helpers.appendToSession({ sessionId, files: { 'nohdr-slug': b64gzip('<html>nohdr</html>') } });
    await helpers.commitSession({ sessionId }); // no token
    const res = await project.axios.get('/content/hashes', { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    expect(res.headers['x-pipeline-token']).toBeUndefined();
  });
});
