import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('TutorialMeta schema', () => {
  it('exposes ownerEmail column on TutorialMeta', () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.ownerEmail).toBeDefined();
    expect(TutorialMeta.elements.ownerEmail.type).toBe('cds.String');
  });

  it('TutorialMeta is managed (has modifiedAt)', () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.modifiedAt).toBeDefined();
    expect(TutorialMeta.elements.createdBy).toBeDefined();
  });
});

// SELECT, INSERT, DELETE are globals attached by cds.test() / vitest globals — no import needed.

describe('MyTutorialsView', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');

    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: 'u-A', uuid: 'uuid-A', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', displayName: 'Alice A' },
      { ID: 'u-B', uuid: 'uuid-B', email: 'bob@example.com',   firstName: 'Bob',   lastName: 'B', displayName: 'Bob B' }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 't-1', slug: 'tut-1', title: 'Tutorial 1', status: 'ACTIVE' },
      { ID: 't-2', slug: 'tut-2', title: 'Tutorial 2', status: 'ACTIVE' },
      { ID: 't-3', slug: 'tut-3', title: 'Orphan',     status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-1', tutorial_ID: 't-1', owner: 'Alice A', ownerEmail: 'alice@example.com' },
      { ID: 'm-2', tutorial_ID: 't-2', owner: 'Bob B',   ownerEmail: 'bob@example.com' },
      { ID: 'm-3', tutorial_ID: 't-3', owner: 'Ghost',   ownerEmail: 'nosuch@example.com' }
    ]);
  });

  it('joins meta to Users by email and exposes ownerUserId', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'alice@example.com' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe('u-A');
    expect(rows[0].slug).toBe('tut-1');
  });

  it('excludes orphaned meta where ownerEmail has no matching Users row', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'nosuch@example.com' }));
    expect(rows).toHaveLength(0);
  });
});

describe('AuthorService surface', () => {
  it('exposes Tutorials, Tags, MyTutorials read entities and review/snooze actions', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.Tutorials).toBeDefined();
    expect(srv.entities.Tags).toBeDefined();
    expect(srv.entities.MyTutorials).toBeDefined();
    expect(srv.operations.reviewTutorial).toBeDefined();
    expect(srv.operations.snoozeTutorial).toBeDefined();
  });

  it('AuthorService.Tutorials is read-only', async () => {
    const srv = await cds.connect.to('AuthorService');
    const tut = srv.entities.Tutorials;
    expect(tut['@readonly']).toBe(true);
  });

  it('denies AuthorService.Tags read for anonymous callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
        tx.run(SELECT.from(srv.entities.Tags))
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  it('allows AuthorService.Tags read for Tutorial.Author callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.Tags))
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});
