// test/unit/homepage-top-tutorials-endpoint.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
const { GET, POST } = cds.test(__dirname + '/../..', '--in-memory');

async function seed() {
  const db = await cds.connect.to('db');
  const { Tutorials, TaskRecords, Users, TopTutorialsSnapshot } = cds.entities(NS);
  await db.run(DELETE.from(TopTutorialsSnapshot));
  await db.run(DELETE.from(TaskRecords));
  await db.run(DELETE.from(Tutorials));
  await db.run(INSERT.into(Tutorials).entries([
    { ID: cds.utils.uuid(), legacyId: 1, slug: 't-a', title: 'A', status: 'ACTIVE', description: 'da' },
  ]));
  const uid = cds.utils.uuid();
  await db.run(INSERT.into(Users).entries([{ ID: uid }]));
  await db.run(INSERT.into(TaskRecords).entries([
    { ID: cds.utils.uuid(), user_ID: uid, taskType: 'TUTORIAL', taskLegacyId: 1, status: 'COMPLETED', completionDate: new Date().toISOString() },
  ]));
}

describe('GET /homepage/topTutorials()', () => {
  beforeAll(async () => {
    await seed();
    const { runTopTutorials } = await import('../../srv/jobs/top-tutorials-job.js');
    const { resetTtCache } = await import('../../srv/homepage-service.js');
    await runTopTutorials('test');
    resetTtCache();
  });

  it('returns windows with hydrated cards + an ETag', async () => {
    const res = await GET`/homepage/topTutorials()`;
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBeTruthy();
    const windows = res.data.windows ?? res.data.value?.[0]?.windows;
    const w180 = windows.find(w => w.windowDays === 180);
    expect(w180.items[0].slug).toBe('t-a');
    expect(w180.items[0].card.title).toBe('A');
    expect(w180.items[0].completions).toBe(1);
  });

  it('honors If-None-Match with a 304', async () => {
    const first = await GET`/homepage/topTutorials()`;
    const etag = first.headers.etag;
    await expect(GET(`/homepage/topTutorials()`, { headers: { 'If-None-Match': etag } }))
      .rejects.toMatchObject({ response: { status: 304 } });
  });
});
