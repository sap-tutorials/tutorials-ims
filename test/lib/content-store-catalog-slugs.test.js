// Issue #114: catalog slug pollution.
//
// PR #115 moved /tutorials/group-* and /tutorials/mission-* off the
// publish-content pipeline to runtime SSR via catalog-data.js. After that
// cutover the publish handler must NEVER persist group-*/mission-* slugs:
//   - content-store would otherwise write them to ContentFiles (orphan rows
//     that the new render path never reads), and
//   - the metadata upsert would create phantom Tutorials rows (no legacyId,
//     wrong title), which then leak into the Admin UI Tutorials list.
//
// Stale local Hugo files left over from the old code path were the trigger:
// publish-content discovers every dir under hugo/public/tutorials/ and ships
// it. The defense lives on the server so any caller — CI, ad-hoc local
// publish, future scripts — gets the same safety net.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const project = cds.test('serve', '--project', '.', '--in-memory');

const API_KEY = 'test-key';

function gz(html) {
  return gzipSync(Buffer.from(html)).toString('base64');
}

describe('content-store filters catalog slugs (issue #114)', () => {
  let Tutorials, ContentFiles, ContentManifest, TutorialMeta, Steps,
      TutorialBodyText, JobLocks;

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    ({ Tutorials, ContentFiles, ContentManifest, TutorialMeta, Steps,
       TutorialBodyText, JobLocks } = cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(TutorialMeta);
    await DELETE.from(Steps);
    await DELETE.from(TutorialBodyText);
    await DELETE.from(Tutorials);
    await DELETE.from(JobLocks);
  });

  it('skips group-* slugs in files and metadata', async () => {
    const tutSlug = 'real-tutorial';
    const grpSlug = 'group-test-two';

    const res = await project.axios.post('/content/publish', {
      trigger: 'test',
      files: {
        [tutSlug]: gz('<p>real</p>'),
        [grpSlug]: gz('<p>should be dropped</p>'),
      },
      metadata: {
        [tutSlug]: {
          slug: tutSlug, title: 'Real', description: '', time: 5,
          level: 'Beginner', primaryTag: 'Test', stepCount: 1,
          steps: [{ number: 1, title: 'Step' }],
        },
        [grpSlug]: {
          slug: grpSlug, title: 'Test Two', description: '', time: 0,
          level: 'beginner', primaryTag: null, stepCount: 0, steps: [],
        },
      },
      bodyTexts: { [tutSlug]: 'real' },
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    expect(res.status).toBe(201);

    // Real tutorial landed.
    const real = await SELECT.one.from(Tutorials).where({ slug: tutSlug });
    expect(real).toBeTruthy();

    // No phantom Tutorials row for the group slug.
    const phantom = await SELECT.one.from(Tutorials).where({ slug: grpSlug });
    expect(phantom).toBeFalsy();

    // No ContentFiles row for the group slug — runtime SSR is the source of
    // truth for /tutorials/group-* now.
    const grpFile = await SELECT.one.from(ContentFiles).where({ slug: grpSlug });
    expect(grpFile).toBeFalsy();

    // The legitimate slug still has its file.
    const realFile = await SELECT.one.from(ContentFiles)
      .where({ slug: tutSlug });
    expect(realFile).toBeTruthy();
  });

  it('skips mission-* slugs in files and metadata', async () => {
    // Mission slug shipped alongside a real tutorial: the real one publishes,
    // the mission slug is dropped silently.
    const realSlug = 'real-mission-test';
    const missionSlug = 'mission-test';

    const res = await project.axios.post('/content/publish', {
      trigger: 'test',
      files: {
        [realSlug]: gz('<p>real</p>'),
        [missionSlug]: gz('<p>noop</p>'),
      },
      metadata: {
        [realSlug]: {
          slug: realSlug, title: 'Real', description: '', time: 5,
          level: 'Beginner', primaryTag: 'Test', stepCount: 0, steps: [],
        },
        [missionSlug]: {
          slug: missionSlug, title: 'Test Mission', description: '', time: 0,
          level: 'beginner', primaryTag: null, stepCount: 0, steps: [],
        },
      },
      bodyTexts: { [realSlug]: 'real' },
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    expect(res.status).toBe(201);
    expect(await SELECT.one.from(Tutorials).where({ slug: missionSlug })).toBeFalsy();
    expect(await SELECT.one.from(ContentFiles).where({ slug: missionSlug })).toBeFalsy();
    expect(await SELECT.one.from(Tutorials).where({ slug: realSlug })).toBeTruthy();
  });

  it('rejects a publish that contains ONLY catalog slugs', async () => {
    // No legitimate slugs to land — fail fast with 400 so a buggy publisher
    // gets a clear signal instead of silently no-op'ing.
    const res = await project.axios.post('/content/publish', {
      trigger: 'test',
      files: { 'group-only': gz('<p>x</p>'), 'mission-only': gz('<p>y</p>') },
      metadata: {},
      bodyTexts: {},
    }, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      validateStatus: () => true,
    });

    expect(res.status).toBe(400);
    expect(res.data?.error).toMatch(/catalog/i);
  });

  it('reserved slugs (__shell__, _index) still pass through', async () => {
    // Sanity: the catalog filter must not over-match other underscore-prefixed
    // payload keys the publisher ships.
    const tutSlug = 'real-two';

    const res = await project.axios.post('/content/publish', {
      trigger: 'test',
      files: {
        [tutSlug]: gz('<p>x</p>'),
        '__shell__': gz('<html><main></main></html>'),
      },
      metadata: {
        [tutSlug]: {
          slug: tutSlug, title: 'Real Two', description: '', time: 5,
          level: 'Beginner', primaryTag: 'Test', stepCount: 0, steps: [],
        },
      },
      bodyTexts: { [tutSlug]: 'x' },
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    expect(res.status).toBe(201);
    expect(await SELECT.one.from(ContentFiles).where({ slug: '__shell__' })).toBeTruthy();
    expect(await SELECT.one.from(Tutorials).where({ slug: tutSlug })).toBeTruthy();
  });

  it('logs a warning when catalog slugs are dropped', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Pair the catalog slug with a real one so the publish doesn't 400.
    const realSlug = 'real-warn';
    await project.axios.post('/content/publish', {
      trigger: 'test',
      files: {
        [realSlug]: gz('<p>r</p>'),
        'group-x': gz('<p>x</p>'),
      },
      metadata: {
        [realSlug]: {
          slug: realSlug, title: 'R', description: '', time: 0,
          level: 'beginner', primaryTag: null, stepCount: 0, steps: [],
        },
        'group-x': {
          slug: 'group-x', title: 'X', description: '', time: 0,
          level: 'beginner', primaryTag: null, stepCount: 0, steps: [],
        },
      },
      bodyTexts: { [realSlug]: 'r' },
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    const allWarnArgs = warnSpy.mock.calls.flat().join(' ');
    expect(allWarnArgs).toMatch(/catalog slug/i);
    expect(allWarnArgs).toContain('group-x');

    warnSpy.mockRestore();
  });
});
