// Schema-level tests for Advocates.user 1:1 optional association.
// Spec: docs/superpowers/specs/2026-06-25-advocate-user-link-design.md
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');

describe('Advocates.user 1:1 association — schema', () => {
  let db;
  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
    db = await cds.deploy(schemaPath).to('sqlite::memory:');
  });
  afterAll(async () => { await db?.disconnect?.(); });

  it('allows null user_ID (advocate without link)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-1', firstName: 'A', lastName: 'B' });
    const row = await SELECT.one.from(Advocates).where({ slug: 'no-link-1' });
    expect(row.user_ID).toBeNull();
  });

  it('allows linking an advocate to a user', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'u-1', email: 'u1@example.com' });
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-1' });
    await INSERT.into(Advocates).entries({ slug: 'linked-1', firstName: 'L', lastName: 'M', user_ID: userRow.ID });
    const adv = await SELECT.one.from(Advocates).where({ slug: 'linked-1' });
    expect(adv.user_ID).toBe(userRow.ID);
  });

  it('rejects linking two advocates to the same user (@assert.unique.user)', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'u-2', email: 'u2@example.com' });
    const userRow = await SELECT.one.from(Users).where({ uuid: 'u-2' });
    await INSERT.into(Advocates).entries({ slug: 'dup-1', firstName: 'D', lastName: 'X', user_ID: userRow.ID });
    await expect(
      INSERT.into(Advocates).entries({ slug: 'dup-2', firstName: 'D', lastName: 'Y', user_ID: userRow.ID })
    ).rejects.toThrow(/UNIQUE|constraint|ASSERT_UNIQUE/i);
  });

  it('allows multiple advocates with null user (NULL ≠ NULL)', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'no-link-2', firstName: 'A', lastName: 'C' });
    await INSERT.into(Advocates).entries({ slug: 'no-link-3', firstName: 'A', lastName: 'D' });
    const rows = await SELECT.from(Advocates).where({ user_ID: null });
    expect(rows.length).toBeGreaterThanOrEqual(2);
  });
});

// /api/advocates handler-shape tests — exercise the public route via a real
// express server bound to an ephemeral port. We avoid supertest (no new
// dev-dep) and use Node's built-in fetch + http.createServer pattern.
describe('/api/advocates — email + tutorials shaping', () => {
  let db;
  let server;
  let baseUrl;

  beforeAll(async () => {
    cds.env.requires.db = { kind: 'sqlite', credentials: { database: ':memory:' } };
    // Fresh in-memory DB so the schema describe block's data doesn't leak.
    db = await cds.deploy(schemaPath).to('sqlite::memory:');
    const advocatesPublic = await import('../../srv/routes/advocates-public.js');
    const app = express();
    advocatesPublic.register(app);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server?.close(resolve));
    await db?.disconnect?.();
  });

  async function fetchAdvocates() {
    const res = await fetch(`${baseUrl}/api/advocates`);
    expect(res.status).toBe(200);
    return res.json();
  }

  it('omits email when advocate has no user link', async () => {
    const { Advocates } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Advocates).entries({ slug: 'public-noemail', firstName: 'P', lastName: 'N', isActive: true });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-noemail');
    expect(adv).toBeDefined();
    expect(adv.email).toBeUndefined();
  });

  it('includes email when advocate is linked and Users.email is non-empty', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-1', email: 'pub1@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-1' });
    await INSERT.into(Advocates).entries({ slug: 'public-withemail', firstName: 'P', lastName: 'E', isActive: true, user_ID: u.ID });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-withemail');
    expect(adv.email).toBe('pub1@example.com');
  });

  it('omits email when linked user has empty/null email', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-noemail', email: null });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-noemail' });
    await INSERT.into(Advocates).entries({ slug: 'public-userwithoutemail', firstName: 'P', lastName: 'X', isActive: true, user_ID: u.ID });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-userwithoutemail');
    expect(adv.email).toBeUndefined();
  });

  it('includes authoredTutorials sorted by title when linked user authored some', async () => {
    const { Advocates, Users, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-2', email: 'pub2@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-2' });
    await INSERT.into(Tutorials).entries([
      { slug: 't-zebra', title: 'Zebra Tutorial', author_ID: u.ID },
      { slug: 't-apple', title: 'Apple Tutorial', author_ID: u.ID },
    ]);
    await INSERT.into(Advocates).entries({ slug: 'public-authored', firstName: 'P', lastName: 'A', isActive: true, user_ID: u.ID });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-authored');
    expect(adv.authoredTutorials).toEqual([
      { slug: 't-apple', title: 'Apple Tutorial' },
      { slug: 't-zebra', title: 'Zebra Tutorial' },
    ]);
  });

  it('omits authoredTutorials when array would be empty', async () => {
    const { Advocates, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-3', email: 'pub3@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-3' });
    await INSERT.into(Advocates).entries({ slug: 'public-noauthored', firstName: 'P', lastName: 'B', isActive: true, user_ID: u.ID });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-noauthored');
    expect(adv.authoredTutorials).toBeUndefined();
  });

  it('flattens contributedTutorials through TutorialContributors.tutorial', async () => {
    const { Advocates, Users, Tutorials, TutorialContributors } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ uuid: 'pub-4', email: 'pub4@example.com' });
    const u = await SELECT.one.from(Users).where({ uuid: 'pub-4' });
    await INSERT.into(Tutorials).entries({ slug: 't-contrib', title: 'Contributed Tutorial' });
    const t = await SELECT.one.from(Tutorials).where({ slug: 't-contrib' });
    await INSERT.into(TutorialContributors).entries({ tutorial_ID: t.ID, user_ID: u.ID });
    await INSERT.into(Advocates).entries({ slug: 'public-contrib', firstName: 'P', lastName: 'C', isActive: true, user_ID: u.ID });
    const body = await fetchAdvocates();
    const adv = body.advocates.find((a) => a.slug === 'public-contrib');
    expect(adv.contributedTutorials).toEqual([{ slug: 't-contrib', title: 'Contributed Tutorial' }]);
  });
});
