import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { loadAssertSpecs } from '../../srv/lib/skill-bundle.js';

beforeAll(async () => {
  await cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:');
});

beforeEach(async () => {
  const { AssertSpecs, Tutorials } = cds.entities('com.sap.developers.ims');
  await DELETE.from(AssertSpecs);
  await DELETE.from(Tutorials);
  await INSERT.into(Tutorials).entries([{ ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', slug: 'tutorial-alpha', title: 'Alpha', status: 'ACTIVE' }]);
  await INSERT.into(AssertSpecs).entries([
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 2, assertIndex: 0, assertType: 'http', httpMethod: 'GET', httpPath: '/foo', expectStatus: 200 },
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 1, assertIndex: 1, assertType: 'cmd', run: 'b', expectExit: 0 },
    { tutorial_ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', stepNumber: 1, assertIndex: 0, assertType: 'cmd', run: 'a', expectExit: 0, matchRegex: 'ok' },
  ]);
});

describe('loadAssertSpecs', () => {
  it('returns [] for an unknown slug', async () => {
    expect(await loadAssertSpecs('nope')).toEqual([]);
  });

  it('orders by (stepNumber, assertIndex) and remaps columns to logical names', async () => {
    const specs = await loadAssertSpecs('tutorial-alpha');
    expect(specs.map((s) => `${s.stepNumber}.${s.assertIndex}`)).toEqual(['1.0', '1.1', '2.0']);
    expect(specs[0]).toMatchObject({ type: 'cmd', run: 'a', expectExit: 0, match: 'ok' });
    expect(specs[2]).toMatchObject({ type: 'http', method: 'GET', path: '/foo', expectStatus: 200 });
  });

  it('lowercases the slug before lookup', async () => {
    const specs = await loadAssertSpecs('TUTORIAL-ALPHA');
    expect(specs).toHaveLength(3);
  });
});
