import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';

const project = cds.test('serve', '--project', '.', '--in-memory');

const API_KEY = 'test-key';

function gz(html) {
  return gzipSync(Buffer.from(html)).toString('base64');
}

describe('content-store TutorialMeta auto-init', () => {
  let Tutorials, TutorialMeta, ContentFiles, ContentManifest, JobLocks;

  beforeAll(() => {
    process.env.CONTENT_API_KEY = API_KEY;
    ({ Tutorials, TutorialMeta, ContentFiles, ContentManifest, JobLocks } =
      cds.entities('com.sap.developers.ims'));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(JobLocks);
  });

  it('creates a TutorialMeta row when publishing a new tutorial', async () => {
    const slug = 'auto-init-new';
    const res = await project.axios.post('/content/publish', {
      trigger: 'test',
      files: { [slug]: gz('<p>hi</p>') },
      metadata: {
        [slug]: {
          slug, title: 'Auto-init New', description: '', time: 5, level: 'Beginner',
          primaryTag: 'Test', stepCount: 1, steps: [{ number: 1, title: 'Step' }],
          lastUpdated: '2026-05-20T10:00:00Z',
          primaryContributorLogin: 'thomasjung-sap',
          primaryContributorEmail: 'thomas.jung@sap.com'
        }
      },
      bodyTexts: { [slug]: 'hi' }
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    expect(res.status).toBe(201);

    const tut = await SELECT.one.from(Tutorials).where({ slug });
    expect(tut).toBeTruthy();
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
    expect(meta).toBeTruthy();
    expect(meta.reviewedDate).toBe('2026-05-20T10:00:00.000Z');
    expect(meta.monitoredStatus).toBe('ACTIVE');
    expect(meta.notificationNumber).toBe(0);
    expect(meta.owner).toBe('thomas.jung@sap.com');
  });

  it('leaves owner null when no primaryContributorEmail in payload', async () => {
    const slug = 'auto-init-no-email';
    await project.axios.post('/content/publish', {
      trigger: 'test',
      files: { [slug]: gz('<p>hi</p>') },
      metadata: { [slug]: {
        slug, title: 'No Email', description: '', time: 5, level: 'Beginner',
        primaryTag: 'Test', stepCount: 0, steps: [],
        lastUpdated: '2026-05-20T10:00:00Z', primaryContributorLogin: 'mystery-user'
      }},
      bodyTexts: { [slug]: 'hi' }
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    const tut = await SELECT.one.from(Tutorials).where({ slug });
    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
    expect(meta.owner).toBeNull();
  });

  it('resets notificationNumber when republished with a newer lastUpdated', async () => {
    const tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'auto-init-refresh', title: 'Old', status: 'ACTIVE'
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tutorialId,
      owner: 'admin@sap.com', monitoredStatus: 'ACTIVE',
      reviewedDate: '2025-01-01T00:00:00.000Z',
      notificationNumber: 3,
      lastNotificationDate: '2026-04-01T00:00:00.000Z',
      legacyId: 9999
    });

    const slug = 'auto-init-refresh';
    await project.axios.post('/content/publish', {
      trigger: 'test',
      files: { [slug]: gz('<p>new</p>') },
      metadata: { [slug]: {
        slug, title: 'Refreshed', description: '', time: 5, level: 'Beginner',
        primaryTag: 'Test', stepCount: 0, steps: [],
        lastUpdated: '2026-05-20T10:00:00Z', primaryContributorLogin: 'someone-else'
      }},
      bodyTexts: { [slug]: 'new' }
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    expect(meta.reviewedDate).toBe('2026-05-20T10:00:00.000Z');
    expect(meta.notificationNumber).toBe(0);
    expect(meta.lastNotificationDate).toBeNull();
    expect(meta.owner).toBe('admin@sap.com');
    expect(meta.monitoredStatus).toBe('ACTIVE');
  });

  it('skips TutorialMeta upsert if reviewedDate already >= lastUpdated', async () => {
    const tutorialId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'auto-init-idempotent', title: 'Idem', status: 'ACTIVE'
    });
    await INSERT.into(TutorialMeta).entries({
      ID: cds.utils.uuid(), tutorial_ID: tutorialId,
      owner: 'someone@sap.com', monitoredStatus: 'ACTIVE',
      reviewedDate: '2026-05-20T10:00:00.000Z',
      notificationNumber: 1,
      lastNotificationDate: '2026-05-21T00:00:00.000Z',
      legacyId: 8888
    });

    const slug = 'auto-init-idempotent';
    await project.axios.post('/content/publish', {
      trigger: 'test',
      files: { [slug]: gz('<p>same</p>') },
      metadata: { [slug]: {
        slug, title: 'Idem', description: '', time: 5, level: 'Beginner',
        primaryTag: 'Test', stepCount: 0, steps: [],
        lastUpdated: '2026-05-20T10:00:00Z',
        primaryContributorEmail: 'noise@sap.com'
      }},
      bodyTexts: { [slug]: 'same' }
    }, { headers: { Authorization: `Bearer ${API_KEY}` } });

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
    expect(meta.notificationNumber).toBe(1);
    expect(meta.lastNotificationDate).toBe('2026-05-21T00:00:00.000Z');
    expect(meta.owner).toBe('someone@sap.com');
  });
});
