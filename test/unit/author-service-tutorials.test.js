// test/unit/author-service-tutorials.test.js
//
// Task 7 (#617) — AuthorService.Tutorials read-only full-row projection.
// Verifies the widened wildcard projection exposes all Tutorials columns
// (not just the legacy slim 5-column subset), and that the entity is
// read-only / auth-gated as declared in srv/author-service.cds.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('AuthorService.Tutorials', () => {
  const tutorialId = 'a7777777-7777-7777-7777-777777777777';

  beforeAll(async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Tutorials).where({ ID: tutorialId });
    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: 'author-read-test',
      title: 'Author Read Test',
      status: 'ACTIVE',
      primaryTag: 'software-product>sap-build',
    });
  });

  it('returns full-row shape for a Tutorial.Author principal', async () => {
    const { GET } = project;
    const res = await GET("/author/Tutorials?$filter=slug eq 'author-read-test'", {
      auth: { username: 'author', password: '' },
    });
    expect(res.status).toBe(200);
    const rows = res.data.value ?? res.data;
    expect(rows.length).toBeGreaterThan(0);
    const row = rows[0];
    // Wildcard projection must expose more than the legacy 5 columns:
    expect(row).toHaveProperty('slug', 'author-read-test');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('primaryTag');
    // Columns that the slim projection didn't expose:
    expect(row).toHaveProperty('createdAt');
    expect(row).toHaveProperty('modifiedAt');
  });

  it('rejects unauthenticated callers', async () => {
    const res = await fetch(`${project.url}/author/Tutorials?$top=1`);
    expect([401, 403]).toContain(res.status);
  });

  it('rejects writes (PATCH) on the read-only projection', async () => {
    const res = await fetch(`${project.url}/author/Tutorials(${tutorialId})`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from('author:').toString('base64'),
      },
      body: JSON.stringify({ title: 'Mutated' }),
    });
    expect([405, 403]).toContain(res.status);
  });
});
