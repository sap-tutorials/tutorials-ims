// test/channels-seed.test.js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';
import { normalizeChannel } from '../srv/lib/channels/normalize.cjs';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

// Mirror the seed's upsert semantics (curated-column preservation) directly against the DB.
async function upsert(raw, batch, { commit = true } = {}) {
  const { Channels } = linked();
  const row = normalizeChannel(raw, batch);
  const existing = await SELECT.one.from(Channels).where({ sourceId: row.sourceId });
  const CURATED = ['isPublished', 'isFeatured', 'editorialNote', 'linkStatus', 'linkStatusOverride', 'lastChecked'];
  if (existing && existing.contentHash === row.contentHash) return 'skipped';
  if (existing) {
    const patch = { ...row }; for (const k of CURATED) delete patch[k];
    if (commit) await UPDATE(Channels).set(patch).where({ ID: existing.ID });
    return 'updated';
  }
  if (commit) await INSERT.into(Channels).entries({ ID: cds.utils.uuid(), ...row });
  return 'inserted';
}

describe('channels seed upsert', () => {
  const base = { id: 'seed-001', name: 'Portal', url: 'https://p', owner_type: 'SAP Official', status: 'Active', purpose: 'A. [cite: 1]' };
  afterAll(async () => { await DELETE.from(linked().Channels).where({ sourceId: 'seed-001' }); });

  it('inserts, then skips unchanged, and preserves curated columns on change', async () => {
    expect(await upsert(base, '2026-09-03')).toBe('inserted');
    // curator flips isFeatured
    const { Channels } = linked();
    await UPDATE(Channels).set({ isFeatured: true }).where({ sourceId: 'seed-001' });
    // same content → skip
    expect(await upsert(base, '2026-09-03')).toBe('skipped');
    // changed purpose → update source col, keep isFeatured
    expect(await upsert({ ...base, purpose: 'B.' }, '2026-09-10')).toBe('updated');
    const row = await SELECT.one.from(Channels).where({ sourceId: 'seed-001' });
    expect(row.purpose).toBe('B.');
    expect(row.isFeatured).toBe(true);
  });
});
