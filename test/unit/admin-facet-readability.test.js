// test/unit/admin-facet-readability.test.js
//
// Guards the three Tutorials Object-Page facet-readability fixes:
//   1. Concepts Taught  — concept_ID FK shows the concept NAME (@Common.Text
//      → concept/name, #TextOnly) instead of a raw GUID.
//   2. Community         — communityId shows the LLM cluster LABEL when present
//      (@Common.Text → labelInfo/label, #TextFirst), member slug as fallback.
//   3. Images            — TutorialImages exposes virtual thumbUrl/viewUrl
//      (the tutorial-system's own served-image URLs); thumbUrl is @UI.IsImageURL
//      and the after('READ') handler fills both from sourceUrl.
//
// Two layers: CSN annotation guards (structural, so a future annotation edit
// can't silently revert), plus a served runtime check of the URL enrichment.
//
// Auth: username='admin', password='admin' (mocked-auth convention).

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const ADMIN_AUTH = { auth: { username: 'admin', password: 'admin' } };
const IMAGES = 'com.sap.developers.ims.TutorialImages';

describe('admin facet readability — CSN annotation guards', () => {
  let csn;
  beforeAll(async () => {
    csn = await cds.load(['srv', 'app', 'db']);
  });

  it('TutorialConceptLinks.concept carries @Common.Text: concept.name (#TextOnly)', () => {
    const el = csn.definitions['AdminService.TutorialConceptLinks']?.elements?.concept;
    expect(el, 'concept association should exist').toBeTruthy();
    expect(el['@Common.Text']?.['=']).toBe('concept.name');
    expect(el['@Common.TextArrangement']?.['#']).toBe('TextOnly');
  });

  it('KgCommunityMembers.communityId carries @Common.Text: labelInfo.label (#TextFirst)', () => {
    const el = csn.definitions['AdminService.KgCommunityMembers']?.elements?.communityId;
    expect(el, 'communityId should exist').toBeTruthy();
    expect(el['@Common.Text']?.['=']).toBe('labelInfo.label');
    expect(el['@Common.TextArrangement']?.['#']).toBe('TextFirst');
  });

  it('KgCommunityMembers exposes the labelInfo association to KgCommunityLabelInfo', () => {
    const el = csn.definitions['AdminService.KgCommunityMembers']?.elements?.labelInfo;
    expect(el, 'labelInfo association should exist').toBeTruthy();
    expect(el.target).toBe('AdminService.KgCommunityLabelInfo');
  });

  it('TutorialImages exposes virtual thumbUrl/viewUrl; thumbUrl is @UI.IsImageURL', () => {
    const els = csn.definitions['AdminService.TutorialImages']?.elements ?? {};
    expect(els.thumbUrl?.virtual).toBe(true);
    expect(els.viewUrl?.virtual).toBe(true);
    expect(els.thumbUrl?.['@UI.IsImageURL']).toBe(true);
  });
});

describe('after(READ, TutorialImages) — served-image URL enrichment', () => {
  const SRC = 'https://github.com/sap-tutorials/Tutorials/raw/master/tutorials/foo/img/a b.png';

  beforeAll(async () => {
    await cds.run(
      INSERT.into(IMAGES).entries(
        {
          ID: cds.utils.uuid(),
          slug: 'facet-readability-test',
          channel: 'prod',
          sourceUrl: SRC,
          mimeType: 'image/png',
          byteSize: 1234,
          contentHash: 'abc',
        },
        {
          // Null sourceUrl → handler must skip enrichment (no crash, no URLs).
          ID: cds.utils.uuid(),
          slug: 'facet-readability-nosrc',
          channel: 'prod',
          sourceUrl: null,
        }
      )
    );
  });

  it('fills thumbUrl (/img-cdn) and viewUrl (/content/image-source) from sourceUrl', async () => {
    const res = await project.get(
      `/admin/TutorialImages?$filter=slug eq 'facet-readability-test'`,
      ADMIN_AUTH
    );
    expect(res.status).toBe(200);
    const row = res.data.value[0];
    expect(row).toBeTruthy();
    const enc = encodeURIComponent(SRC);
    expect(row.thumbUrl).toBe(`/img-cdn?u=${enc}`);
    expect(row.viewUrl).toBe(`/content/image-source?u=${enc}`);
  });

  it('leaves thumbUrl/viewUrl unset when sourceUrl is null (no crash)', async () => {
    const res = await project.get(
      `/admin/TutorialImages?$filter=slug eq 'facet-readability-nosrc'`,
      ADMIN_AUTH
    );
    expect(res.status).toBe(200);
    const row = res.data.value[0];
    expect(row).toBeTruthy();
    expect(row.thumbUrl == null).toBe(true);
    expect(row.viewUrl == null).toBe(true);
  });
});
