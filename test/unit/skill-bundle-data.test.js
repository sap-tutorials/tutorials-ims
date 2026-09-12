import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { loadAssertSpecs, makeFreshnessStampLoader } from '../../srv/lib/skill-bundle.js';

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

describe('freshness stamp', () => {
  const inputs = { contentHash: 'h', sourceCommit: 'sha1', builtAt: '2026-09-01', report: { status: 'DONE', runAt: '2026-09-01', openHighCount: 0 } };

  it('derives confidence + commit without a signing key, no jws when provenance disabled', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => inputs,
      deriveConfidence: () => 'high',
      buildEnvelope: async () => ({ jws: 'should.not.appear' }),
    });
    const stamp = await load('s', { provenanceEnabled: false });
    expect(stamp).toMatchObject({ confidence: 'high', sourceCommit: 'sha1', lastVerified: '2026-09-01', jws: null });
  });

  it('adds jws when provenance enabled and envelope builds', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => inputs,
      deriveConfidence: () => 'high',
      buildEnvelope: async () => ({ jws: 'eyJ.sig' }),
    });
    const stamp = await load('s', { provenanceEnabled: true });
    expect(stamp.jws).toBe('eyJ.sig');
  });

  it('fail-open to unknown when inputs are null', async () => {
    const load = makeFreshnessStampLoader({
      loadProvenanceInputs: async () => null,
      deriveConfidence: () => 'unknown',
      buildEnvelope: async () => null,
    });
    const stamp = await load('s', { provenanceEnabled: true });
    expect(stamp).toEqual({ confidence: 'unknown', lastVerified: null, sourceCommit: null, jws: null });
  });
});
