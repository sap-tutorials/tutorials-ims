import './_setup.js'; // installs cds.once monkey-patch + folders.srv redirect (see file for rationale)
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Inject a Tutorial.Author mock user before cds.test bootstraps the server.
// .cdsrc.json only defines developer/admin/display/consolidation users — none
// carry Tutorial.Author. Adding here avoids modifying shared production config.
cds.env.requires ??= {};
cds.env.requires.auth ??= {};
// kind must be mocked explicitly — the root .cdsrc.json sets mocked for tests,
// but we need it stable here in case cds.env reloads.
cds.env.requires.auth.kind = 'mocked';
cds.env.requires.auth.users ??= {};
cds.env.requires.auth.users['tutorial-author'] = {
  password: 'author',
  roles: ['Tutorial.Author']
};

const authorAuth = { auth: { username: 'tutorial-author', password: 'author' } };

// Serve only the QA search service in isolation.
// Reason: both prod srv/search-service.cds and this service register as
// 'SearchService' at /search.  Using --project . would load both and collide.
// Passing the .cds file path directly (with extension so exists() returns true)
// loads only this model file and its db-qa imports, avoiding the full srv/ model.
const project = cds.test('serve', 'srv-qa/search-service.cds', '--in-memory');

describe('QA SearchService', () => {
  beforeAll(async () => {
    await INSERT.into('com.sap.developers.ims.qa.TutorialBodyText').entries([
      { slug: '__TEST__qa-search-1', bodyText: 'configure cap on btp cloud' },
      { slug: '__TEST__qa-search-2', bodyText: 'unrelated topic about widgets' }
    ]);
  });

  it('finds qa tutorials by full-text $search', async () => {
    const { data } = await project.get(
      '/search/Tutorials?$search=cap',
      authorAuth
    );
    expect(data.value.some(r => r.slug === '__TEST__qa-search-1')).toBe(true);
    expect(data.value.some(r => r.slug === '__TEST__qa-search-2')).toBe(false);
  });

  it('service definition carries @requires Tutorial.Author', () => {
    const svc = cds.model.definitions['SearchService'];
    expect(svc['@requires']).toBe('Tutorial.Author');
  });
});
