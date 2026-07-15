// test/unit/kg/community-catalog-layer.test.js
// Unit tests for communityCatalogLayer (#1173). Uses in-memory SQLite to seed
// KgCommunityLabel; asserts flag gating + fail-open.
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';
import { communityCatalogLayer } from '../../../srv/lib/chat-context.js';

const DB_PATH = path.join(process.cwd(), 'db');
const NS = 'com.sap.developers.ims';
const FP1 = 'f'.repeat(64);
const FP2 = '9'.repeat(64);

let db;
beforeAll(async () => {
  await cds.deploy(DB_PATH).to('sqlite::memory:');
  db = await cds.connect.to('db');
  const { KgCommunityLabel } = cds.entities(NS);
  await db.run(DELETE.from(KgCommunityLabel).where({ communityFingerprint: { in: [FP1, FP2] } }));
  await db.run(INSERT.into(KgCommunityLabel).entries([
    { communityFingerprint: FP1, label: 'SAP RAP & Fiori Elements', rationale: 'r', memberSlugsHash: '0'.repeat(64) },
    { communityFingerprint: FP2, label: 'CAP & Node.js Services',   rationale: 'r', memberSlugsHash: '1'.repeat(64) },
  ]));
});

describe('communityCatalogLayer', () => {
  it('returns empty string when flag is off', async () => {
    expect(await communityCatalogLayer({ communityPeersEnabled: false })).toBe('');
    expect(await communityCatalogLayer(null)).toBe('');
  });

  it('lists labels and guidance when flag on', async () => {
    const out = await communityCatalogLayer({ communityPeersEnabled: true });
    expect(out).toContain('SAP RAP & Fiori Elements');
    expect(out).toContain('CAP & Node.js Services');
    expect(out).toMatch(/describeCommunity/);
  });
});
