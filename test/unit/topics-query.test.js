// test/unit/topics-query.test.js
import { describe, it, beforeAll, expect } from 'vitest';
import cds from '@sap/cds';
import {
  loadLiveTags, buildTopicsTreePayload, resolveTopicBySlug, buildTopicDetailPayload,
} from '../../srv/lib/topics-query.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

describe('topics-query', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { Tutorials, Tags, TutorialTags, TutorialConceptLinks, Concepts } = cds.entities(NS);
    await db.run(INSERT.into(Tags).entries([
      // Real titlePath shape: facet split by " : ", hierarchy levels by " / ".
      { ID: 't1', titlePath: 'Software Product : SAP HANA Cloud', label: 'SAP HANA Cloud', name: 'sap-hana-cloud' },
      { ID: 't2', titlePath: 'Software Product : Database / SAP HANA Cloud / Data Lake', label: 'Data Lake', name: 'sap-hana-cloud-data-lake' },
    ]));
    await db.run(INSERT.into(Tutorials).entries([
      { ID: 'tut1', slug: 'hana-intro', title: 'HANA Intro', experienceTag: 'Beginner' },
      { ID: 'tut2', slug: 'data-lake-intro', title: 'Data Lake Intro', experienceTag: 'Beginner' },
    ]));
    await db.run(INSERT.into(TutorialTags).entries([
      { tutorial_ID: 'tut1', tag_ID: 't1' },
      { tutorial_ID: 'tut2', tag_ID: 't2' },
    ]));
    await db.run(INSERT.into(Concepts).entries([
      { ID: 'c1', slug: 'in-memory-database', name: 'In-Memory Database', status: 'ACTIVE', publishedAt: new Date().toISOString() },
    ]));
    await db.run(INSERT.into(TutorialConceptLinks).entries([
      { ID: 'l1', tutorial_ID: 'tut1', concept_ID: 'c1', predicate: 'teaches' },
    ]));
  });

  it('loadLiveTags returns only tags with ≥1 tutorial, with counts', async () => {
    const live = await loadLiveTags(db);
    const slugs = live.map(t => t.slug).sort();
    expect(slugs).toContain('software-product-sap-hana-cloud');
    const hana = live.find(t => t.slug === 'software-product-sap-hana-cloud');
    expect(hana.tutorialCount).toBe(1);
    expect(hana.conceptCount).toBe(1);
    expect(hana.facet).toBe('Software Product');
    expect(hana.segments).toEqual(['SAP HANA Cloud']);
  });

  it('buildTopicsTreePayload nests facet → hierarchy folders → leaf', async () => {
    const { tree, error } = await buildTopicsTreePayload(db);
    expect(error).toBeFalsy();
    const facet = tree.find(f => f.facet === 'Software Product');
    expect(facet).toBeTruthy();
    // single-level tag is a direct leaf under the facet
    expect(facet.children.some(n => n.slug === 'software-product-sap-hana-cloud')).toBe(true);
    // multi-level tag: Database (folder) → SAP HANA Cloud (folder) → Data Lake (leaf)
    const database = facet.children.find(n => n.label === 'Database' || n.name === 'Database');
    expect(database).toBeTruthy();
    expect(database.children?.length).toBeGreaterThan(0);
    const mid = database.children.find(n => (n.label || n.name) === 'SAP HANA Cloud');
    expect(mid).toBeTruthy();
    const leaf = mid.children.find(n => n.slug === 'software-product-database-sap-hana-cloud-data-lake');
    expect(leaf).toBeTruthy();
    expect(leaf.tutorialCount).toBe(1);
  });

  it('buildTopicDetailPayload returns tutorials + concepts', async () => {
    const p = await buildTopicDetailPayload(db, 'software-product-sap-hana-cloud');
    expect(p.notFound).toBeFalsy();
    expect(p.tutorials.map(t => t.slug)).toContain('hana-intro');
    expect(p.concepts.map(c => c.slug)).toContain('in-memory-database');
  });

  it('resolveTopicBySlug strips legacy -N and redirects', async () => {
    const r = await resolveTopicBySlug(db, 'software-product-sap-hana-cloud-2');
    expect(r.tag?.slug).toBe('software-product-sap-hana-cloud');
    expect(r.redirectTo).toBe('/topics/software-product-sap-hana-cloud/');
  });

  it('unknown slug is notFound with redirect to /topics/', async () => {
    const p = await buildTopicDetailPayload(db, 'does-not-exist');
    expect(p.notFound).toBe(true);
    expect(p.redirectTo).toBe('/topics/');
  });
});
