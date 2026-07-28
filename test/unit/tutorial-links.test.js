import { describe, it, expect } from 'vitest';
import { buildTutorialLinks } from '../../srv/lib/tutorial-links.js';

describe('buildTutorialLinks', () => {
  const base = { status: 'ACTIVE', slug: 'my-tut', owner: 'sap-tutorials', repo: 'Tutorials', branch: 'main' };

  it('builds all 8 fields for an ACTIVE row with a full catalog entry', () => {
    expect(buildTutorialLinks(base)).toEqual({
      sourceRepoUrl:    'https://github.com/sap-tutorials/Tutorials/tree/main/tutorials/my-tut',
      sourceRepoLabel:  'sap-tutorials/Tutorials',
      contribRepoUrl:   'https://github.com/sap-tutorials/Tutorials-Contribution/tree/main/tutorials/my-tut',
      contribRepoLabel: 'sap-tutorials/Tutorials-Contribution',
      qaPreviewUrl:     '/tutorials-qa/my-tut',
      qaPreviewLabel:   'View QA Preview',
      mainPreviewUrl:   '/tutorials/my-tut',
      mainPreviewLabel: 'View Live Tutorial',
    });
  });

  it('returns all-undefined for a non-ACTIVE row', () => {
    const out = buildTutorialLinks({ ...base, status: 'INACTIVE' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });

  it('sets QA/main but not GitHub links when repo is missing', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: 'my-tut', owner: null, repo: null, branch: null });
    expect(out.qaPreviewUrl).toBe('/tutorials-qa/my-tut');
    expect(out.mainPreviewUrl).toBe('/tutorials/my-tut');
    expect(out.sourceRepoUrl).toBeUndefined();
    expect(out.contribRepoUrl).toBeUndefined();
  });

  it('defaults owner to sap-tutorials and branch to main when null', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: 'my-tut', owner: null, repo: 'Tutorials', branch: null });
    expect(out.sourceRepoUrl).toBe('https://github.com/sap-tutorials/Tutorials/tree/main/tutorials/my-tut');
    expect(out.sourceRepoLabel).toBe('sap-tutorials/Tutorials');
  });

  it('returns all-undefined when slug is missing', () => {
    const out = buildTutorialLinks({ status: 'ACTIVE', slug: null, owner: 'x', repo: 'y', branch: 'main' });
    expect(Object.values(out).every((v) => v === undefined)).toBe(true);
  });
});
