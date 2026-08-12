import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { modelJsonHandler } from '../../lib/model-json-handler.js';

const NS = 'com.sap.developers.ims';

function makeReq(slug, originalUrl) {
  return { params: { slug }, originalUrl: originalUrl ?? `/content/tutorial-model/${slug}` };
}
function makeRes() {
  return {
    _status: 200, _body: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; },
    end() { return this; },
  };
}

const cp = (doc) => doc[':items'].par[':items'].par1[':items'].contentParsys;

cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/tutorial-model/:slug', () => {
  const TUT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

  beforeAll(async () => {
    await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { Tutorials, Tags, TutorialTags, TutorialContributors, RepoCatalog, Users } =
      cds.entities(NS);
    await DELETE.from(TutorialTags);
    await DELETE.from(TutorialContributors);
    await DELETE.from(Tutorials);
    await DELETE.from(Tags);
    await DELETE.from(RepoCatalog);
    await DELETE.from(Users);

    await INSERT.into(Tutorials).entries({
      ID: TUT_ID,
      slug: 'abap-create-project',
      title: 'Create an ABAP Project in ABAP Development Tools (ADT)',
      description: 'Configure the Eclipse IDE with the ABAP Development Tools.',
      legacyId: 105,
      experienceTag: 'beginner',
      averageTimeToComplete: 15,
      status: 'ACTIVE',
    });

    const TAG_ID = 'bbbbbbbb-0000-0000-0000-000000000001';
    await INSERT.into(Tags).entries({
      ID: TAG_ID, name: 'abap-development', label: 'ABAP Development',
      titlePath: 'programming-tool:abap-development',
    });
    await INSERT.into(TutorialTags).entries({ tutorial_ID: TUT_ID, tag_ID: TAG_ID });

    const USER_ID = 'cccccccc-0000-0000-0000-000000000001';
    await INSERT.into(Users).entries({ ID: USER_ID, uuid: USER_ID, githubLogin: 'olgadolinskaja' });
    await INSERT.into(TutorialContributors).entries({
      ID: 'dddddddd-0000-0000-0000-000000000001',
      tutorial_ID: TUT_ID, name: 'olgadolinskaja', role: 'creator', user_ID: USER_ID,
    });

    await INSERT.into(RepoCatalog).entries({
      slug: 'abap-create-project',
      payload: JSON.stringify({ slug: 'abap-create-project', owner: 'sap-tutorials', repo: 'abap-core-development', branch: 'main' }),
    });
  });

  it('serves the AEM-shaped model.json with the GitHub repo link', async () => {
    const res = makeRes();
    await modelJsonHandler(makeReq('abap-create-project'), res);

    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toMatch(/application\/json/);
    expect(res._body[':path']).toBe('/tutorials/abap-create-project.html');
    expect(res._body[':type']).toBe('developers/components/page/responsive/tutorialPage');

    const parsys = cp(res._body);
    expect(parsys.title).toBe('Create an ABAP Project in ABAP Development Tools (ADT)');
    expect(parsys.imsId).toBe(105);
    expect(parsys.tags).toEqual({ 'ABAP Development': 'programming-tool:abap-development' });

    const gh = parsys.buttonBar.feedbackModel.options.find((o) => o.linkType === 'github');
    expect(gh.href).toContain('github.com/sap-tutorials/abap-core-development/issues/new');
    expect(parsys.tutorialDescription.contributors.creator.login).toBe('olgadolinskaja');
  });

  it('404s for an unknown slug', async () => {
    const res = makeRes();
    await modelJsonHandler(makeReq('does-not-exist'), res);
    expect(res._status).toBe(404);
    expect(res._body.error).toMatch(/not found/i);
  });

  it('301s a mixed-case slug to the canonical lowercase .model.json', async () => {
    const res = makeRes();
    await modelJsonHandler(makeReq('ABAP-Create-Project'), res);
    expect(res._status).toBe(301);
    expect(res._headers.Location).toBe('/tutorials/abap-create-project.model.json');
  });

  it('404s an invalid slug shape without touching the DB', async () => {
    const res = makeRes();
    await modelJsonHandler(makeReq('../etc/passwd'), res);
    expect(res._status).toBe(404);
  });
});
