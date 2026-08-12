import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildModelJson, buildContributors, buildTags } from '../model-json.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const legacy = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'legacy-abap-create-project.model.json'), 'utf-8'),
);

// Navigate to the contentParsys node in either the legacy fixture or our output.
const contentParsys = (doc) =>
  doc[':items'].par[':items'].par1[':items'].contentParsys;

const githubHref = (doc) =>
  contentParsys(doc).buttonBar.feedbackModel.options.find((o) => o.linkType === 'github')?.href;

const sample = {
  slug: 'abap-create-project',
  title: 'Create an ABAP Project in ABAP Development Tools (ADT)',
  description: 'Configure the Eclipse IDE with the ABAP Development Tools for SAP NetWeaver (ADT) and create an ABAP project.',
  legacyId: 105,
  experienceTag: 'beginner',
  averageTimeToComplete: 15,
  tags: [
    { label: 'ABAP Development', titlePath: 'programming-tool:abap-development' },
    { label: 'Beginner', titlePath: 'tutorial:experience/beginner' },
  ],
  contributors: [
    { name: 'olgadolinskaja', login: 'olgadolinskaja', role: 'creator' },
    { name: 'Julie Plummer', login: 'julieplummer20', role: 'owner' },
    { name: 'akula86', login: 'akula86', role: 'collaborator' },
  ],
  owner: 'sap-tutorials',
  repo: 'abap-core-development',
  branch: 'main',
};

describe('model-json builder', () => {
  it('reproduces the legacy top-level envelope keys', () => {
    const out = buildModelJson(sample);
    expect(Object.keys(out).sort()).toEqual(Object.keys(legacy).sort());
  });

  it('sets :path and :type exactly as the legacy page export', () => {
    const out = buildModelJson(sample);
    expect(out[':path']).toBe('/tutorials/abap-create-project.html');
    expect(out[':type']).toBe(legacy[':type']);
    expect(out[':type']).toBe('developers/components/page/responsive/tutorialPage');
    expect(out[':itemsOrder']).toEqual(legacy[':itemsOrder']);
  });

  it('places the GitHub repo link in the same feedbackModel option DC parses', () => {
    const out = buildModelJson(sample);
    const href = githubHref(out);
    expect(href).toBeTruthy();
    // The repo name is what DC extracts to load + render content.
    expect(href).toContain('https://github.com/sap-tutorials/abap-core-development/issues/new');
    const repo = href.match(/github\.com\/sap-tutorials\/([^/]+)\/issues/)?.[1];
    expect(repo).toBe('abap-core-development');
    // Same option shape the legacy export used.
    const legacyGh = contentParsys(legacy).buttonBar.feedbackModel.options.find((o) => o.linkType === 'github');
    const ourGh = contentParsys(out).buttonBar.feedbackModel.options.find((o) => o.linkType === 'github');
    expect(Object.keys(ourGh).sort()).toEqual(Object.keys(legacyGh).sort());
  });

  it('reproduces the exact legacy github href for the known sample', () => {
    // Byte-for-byte match against the recovered 2023 snapshot's href.
    expect(githubHref(buildModelJson(sample))).toBe(githubHref(legacy));
  });

  it('carries title, description, imsId and tags into contentParsys', () => {
    const cp = contentParsys(buildModelJson(sample));
    expect(cp.title).toBe(sample.title);
    expect(cp.description).toBe(sample.description);
    expect(cp.imsId).toBe(105);
    expect(cp.tags).toEqual({
      'ABAP Development': 'programming-tool:abap-development',
      Beginner: 'tutorial:experience/beginner',
    });
  });

  it('maps contributors into creator / owner / collaborators', () => {
    const c = contentParsys(buildModelJson(sample)).tutorialDescription.contributors;
    expect(c.creator.login).toBe('olgadolinskaja');
    expect(c.creator.profileUrl).toBe('https://github.com/olgadolinskaja');
    expect(c.owner.login).toBe('julieplummer20');
    expect(c.owner.name).toBe('Julie Plummer');
    expect(c.collaborators.map((x) => x.login)).toEqual(['akula86']);
  });

  it('omits the github option (keeps community + survey) when no repo is known', () => {
    const out = buildModelJson({ ...sample, repo: null });
    const opts = contentParsys(out).buttonBar.feedbackModel.options;
    expect(opts.map((o) => o.linkType)).toEqual(['community', 'survey']);
  });

  it('keeps tutorialBody shape but leaves steps empty (out of scope)', () => {
    const body = contentParsys(buildModelJson(sample)).tutorialBody;
    expect(body).toEqual({ intro: '', steps: [] });
  });

  it('is JSON-serializable and requires a slug', () => {
    expect(() => JSON.stringify(buildModelJson(sample))).not.toThrow();
    expect(() => buildModelJson({})).toThrow(/slug/);
  });

  it('buildTags / buildContributors tolerate empty input', () => {
    expect(buildTags()).toEqual({});
    expect(buildContributors()).toEqual({ collaborators: [] });
  });
});
