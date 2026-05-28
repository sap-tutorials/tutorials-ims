// test/render-catalog-page.test.js
//
// Verifies the dynamic-render fallback that synthesizes a Group/Mission page
// when ContentFiles has no published HTML for the slug. This closes the gap
// between an admin saving a new Group/Mission and the next CI publish run
// (issue #74).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SHELL_STYLESHEETS } from '../srv/lib/render-catalog-page.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

function makePayload(files) {
  const result = {};
  for (const [slug, html] of Object.entries(files)) {
    result[slug] = gzipSync(Buffer.from(html, 'utf-8')).toString('base64');
  }
  return result;
}

const API_KEY = 'test-render-key';

const TAG_ID    = 'aaaaaaaa-r000-0000-0000-000000000001';
const TUT1_ID   = 'cccccccc-r000-0000-0000-000000000001';
const TUT2_ID   = 'cccccccc-r000-0000-0000-000000000002';
const GROUP_ID  = 'bbbbbbbb-r000-0000-0000-000000000001';
const MISSION_ID = 'dddddddd-r000-0000-0000-000000000001';
const PATH_ID    = 'eeeeeeee-r000-0000-0000-000000000001';
const CPI_ID     = 'ffffffff-r000-0000-0000-000000000001';

describe('GET /content/tutorials/group-* and mission-* synthesis fallback', () => {
  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
  });

  beforeEach(async () => {
    const { ContentFiles, ContentManifest, Groups, Missions, Tutorials, GroupPathItems,
            CompletionPaths, CompletionPathItems, Tags, JobLocks } =
      cds.entities('com.sap.developers.ims');

    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(GroupPathItems);
    await DELETE.from(CompletionPathItems);
    await DELETE.from(CompletionPaths);
    await DELETE.from(Groups);
    await DELETE.from(Missions);
    await DELETE.from(Tutorials);
    await DELETE.from(Tags);
    await DELETE.from(JobLocks);

    // Seed a published manifest so getActiveVersion() returns a number — the
    // synthesizer only fires *after* that check.
    await project.axios.post('/content/publish', {
      trigger: 'render-test',
      hugoVersion: '0.147.0',
      files: makePayload({ '__seed__': '<p>seed</p>' }),
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    // Seed shared catalog data.
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 80001, name: '__TEST__ Render Tag' });
    await INSERT.into(Tutorials).entries([
      { ID: TUT1_ID, legacyId: 80011, slug: 'render-tut-1', title: 'Render Tut 1', status: 'ACTIVE' },
      { ID: TUT2_ID, legacyId: 80012, slug: 'render-tut-2', title: 'Render Tut 2', status: 'ACTIVE' },
    ]);
  });

  describe('group-<slug>', () => {
    beforeEach(async () => {
      const { Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Groups).entries({
        ID: GROUP_ID, legacyId: 80021,
        slug: 'render-group',
        title: '__TEST__ Render Group',
        description: 'A group rendered from DB',
        published: true, status: 'ACTIVE',
      });
      await INSERT.into(GroupPathItems).entries([
        { ID: 'eeeeeeee-r000-0000-0000-000000000010', group_ID: GROUP_ID, tutorial_ID: TUT1_ID, itemOrder: 0 },
        { ID: 'eeeeeeee-r000-0000-0000-000000000011', group_ID: GROUP_ID, tutorial_ID: TUT2_ID, itemOrder: 1 },
      ]);
    });

    it('synthesizes 200 HTML when no ContentFiles entry exists', async () => {
      const res = await project.axios.get('/content/tutorials/group-render-group');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.headers['x-content-source']).toBe('synthesized');
      expect(res.data).toContain('__TEST__ Render Group');
      // Tutorials are linked in itemOrder.
      expect(res.data).toContain('/tutorials/render-tut-1');
      expect(res.data).toContain('/tutorials/render-tut-2');
      expect(res.data.indexOf('render-tut-1')).toBeLessThan(res.data.indexOf('render-tut-2'));
    });

    it('escapes HTML in title/description', async () => {
      const { Groups } = cds.entities('com.sap.developers.ims');
      await UPDATE(Groups).set({ title: '<script>x</script>', description: 'A & B' }).where({ ID: GROUP_ID });

      const res = await project.axios.get('/content/tutorials/group-render-group');
      expect(res.status).toBe(200);
      expect(res.data).not.toContain('<script>x</script>');
      expect(res.data).toContain('&lt;script&gt;x&lt;/script&gt;');
      expect(res.data).toContain('A &amp; B');
    });

    it('falls through to 404 when group is unpublished', async () => {
      const { Groups } = cds.entities('com.sap.developers.ims');
      await UPDATE(Groups).set({ published: false }).where({ ID: GROUP_ID });

      const res = await project.axios.get('/content/tutorials/group-render-group', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });

    it('falls through to 404 when group has INACTIVE status', async () => {
      const { Groups } = cds.entities('com.sap.developers.ims');
      await UPDATE(Groups).set({ status: 'INACTIVE' }).where({ ID: GROUP_ID });

      const res = await project.axios.get('/content/tutorials/group-render-group', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown group slug', async () => {
      const res = await project.axios.get('/content/tutorials/group-does-not-exist', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });

    it('does NOT synthesize when ContentFiles already has the slug published', async () => {
      const html = '<p>real published group HTML</p>';
      await project.axios.post('/content/publish', {
        trigger: 'render-test',
        hugoVersion: '0.147.0',
        files: makePayload({ 'group-render-group': html, '__seed__': '<p>seed</p>' }),
      }, { headers: { Authorization: `Bearer ${API_KEY}` } });

      const res = await project.axios.get('/content/tutorials/group-render-group');
      expect(res.status).toBe(200);
      expect(res.headers['x-content-source']).toBe('db');
      expect(res.data).toBe(html);
    });

    // Regression for #91: synthesizer linked to /css/main.css which doesn't
    // exist, leaving newly-renamed groups/missions unstyled until the next
    // CI publish. Pin the contract to the actual Hugo asset set.
    it('emits stylesheet refs that all exist in the Hugo asset pipeline', async () => {
      const res = await project.axios.get('/content/tutorials/group-render-group');
      expect(res.status).toBe(200);

      const linkedHrefs = [...res.data.matchAll(/<link\b[^>]*\bhref="([^"]+)"/g)]
        .map(m => m[1])
        .filter(h => h.startsWith('/css/'));

      expect(linkedHrefs).toEqual(SHELL_STYLESHEETS);

      // Every linked file must exist in hugo/assets/css/ — that's the source
      // Hugo bundles into the deployed approuter at the same /css/ path.
      const assetsDir = join(process.cwd(), 'hugo', 'assets', 'css');
      for (const href of linkedHrefs) {
        const filename = href.replace(/^\/css\//, '');
        expect(existsSync(join(assetsDir, filename)),
          `${href} referenced by synthesizer but missing from hugo/assets/css/`)
          .toBe(true);
      }
    });
  });

  describe('mission-<slug>', () => {
    beforeEach(async () => {
      const { Missions, Groups, CompletionPaths, CompletionPathItems, GroupPathItems } =
        cds.entities('com.sap.developers.ims');

      await INSERT.into(Missions).entries({
        ID: MISSION_ID, legacyId: 80031,
        slug: 'render-mission',
        title: '__TEST__ Render Mission',
        description: 'A mission rendered from DB',
        published: true, status: 'ACTIVE',
        primaryTagRef_ID: TAG_ID,
      });
      await INSERT.into(Groups).entries({
        ID: GROUP_ID, legacyId: 80022,
        slug: 'mission-group',
        title: '__TEST__ Mission Group',
        published: true, status: 'ACTIVE',
      });
      await INSERT.into(CompletionPaths).entries({
        ID: PATH_ID, legacyId: 80041,
        mission_ID: MISSION_ID, name: 'Path', slug: 'path',
      });
      await INSERT.into(CompletionPathItems).entries({
        ID: CPI_ID, legacyId: 80051,
        path_ID: PATH_ID, group_ID: GROUP_ID, taskType: 'GROUP', itemOrder: 0,
      });
      await INSERT.into(GroupPathItems).entries({
        ID: 'eeeeeeee-r000-0000-0000-000000000020',
        group_ID: GROUP_ID, tutorial_ID: TUT1_ID, itemOrder: 0,
      });
    });

    it('synthesizes 200 HTML with nested group cards', async () => {
      const res = await project.axios.get('/content/tutorials/mission-render-mission');
      expect(res.status).toBe(200);
      expect(res.headers['x-content-source']).toBe('synthesized');
      expect(res.data).toContain('__TEST__ Render Mission');
      expect(res.data).toContain('__TEST__ Mission Group');
      expect(res.data).toContain('/tutorials/group-mission-group');
      expect(res.data).toContain('/tutorials/render-tut-1');
    });

    it('returns 404 for unknown mission slug', async () => {
      const res = await project.axios.get('/content/tutorials/mission-does-not-exist', {
        validateStatus: () => true,
      });
      expect(res.status).toBe(404);
    });
  });
});
