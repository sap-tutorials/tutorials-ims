import { describe, expect, it, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import {
  processLogoUpload,
  uploadAndUpsertLogo,
  clearLogo,
  fetchLogo,
} from '../../../srv/lib/event-logo-store.js';

// Per-event logo lockup store (#2133). Mirrors the advocate-photo-upsert test:
// exercises the pure helpers against an in-memory DB, not the OData bound
// action or the anonymous GET route (those have their own surfaces). Reuses
// the advocate fixtures (a JPEG + a PNG) — the sharp pipeline is identical.

const FIX = (name) => readFile(`test/unit/advocates/fixtures/${name}`);

const project = cds.test('serve', '--project', '.', '--in-memory');

const EVENT_ID = 'EVT02133-0000-0000-0000-000000000001';
const LEGACY_ID = 902133;

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Events, EventLogo } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.one.from(Events).where({ ID: EVENT_ID }));
  if (!existing) {
    await db.run(INSERT.into(Events).entries({
      ID: EVENT_ID,
      legacyId: LEGACY_ID,
      name: 'Logo Store Test Event',
      eventType: 'OTHER',
      hasLogo: false,
    }));
  } else {
    // Reset state across reruns so tests are order-independent.
    await db.run(DELETE.from(EventLogo).where({ event_ID: EVENT_ID }));
    await db.run(UPDATE(Events).set({ hasLogo: false, logoUpdatedAt: null }).where({ ID: EVENT_ID }));
  }
});

describe('processLogoUpload (sharp → WebP pipeline)', () => {
  it('rejects a non-buffer', async () => {
    await expect(processLogoUpload(null, 'image/png')).rejects.toThrow(/buffer is required/);
  });

  it('rejects an unsupported MIME', async () => {
    await expect(processLogoUpload(Buffer.from('x'), 'application/octet-stream'))
      .rejects.toThrow(/unsupported MIME/);
  });

  it('rejects oversized input', async () => {
    const big = Buffer.alloc(8 * 1024 * 1024 + 1);
    await expect(processLogoUpload(big, 'image/png')).rejects.toThrow(/too large/);
  });

  it('rejects garbage bytes even with an allowed MIME', async () => {
    await expect(processLogoUpload(Buffer.from('not-an-image'), 'image/png'))
      .rejects.toThrow(/invalid image bytes/);
  });

  it('converts a valid JPEG to WebP with a sha256', async () => {
    const jpeg = await FIX('portrait.jpg');
    const out = await processLogoUpload(jpeg, 'image/jpeg');
    expect(out.mimeType).toBe('image/webp');
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(out.sizeBytes).toBeGreaterThan(0);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });
});

describe('uploadAndUpsertLogo + fetchLogo + clearLogo', () => {
  it('rejects when eventID is missing', async () => {
    await expect(uploadAndUpsertLogo({ eventID: '', buffer: Buffer.from('x'), mimeType: 'image/png' }))
      .rejects.toThrow(/eventID is required/);
  });

  it('rejects when buffer is missing', async () => {
    await expect(uploadAndUpsertLogo({ eventID: EVENT_ID, buffer: null, mimeType: 'image/png' }))
      .rejects.toThrow(/buffer is required/);
  });

  it('uploads a logo, flips hasLogo, and is readable via fetchLogo', async () => {
    const db = await cds.connect.to('db');
    const { Events, EventLogo } = cds.entities('com.sap.developers.ims');

    const jpeg = await FIX('portrait.jpg');
    const result = await uploadAndUpsertLogo({ eventID: EVENT_ID, buffer: jpeg, mimeType: 'image/jpeg' });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBeGreaterThan(0);

    // Events flags flipped.
    const ev = await db.run(SELECT.one.from(Events).columns('hasLogo', 'logoUpdatedAt').where({ ID: EVENT_ID }));
    expect(ev.hasLogo).toBe(true);
    expect(ev.logoUpdatedAt).toBeTruthy();

    // EventLogo row written (metadata columns only — never SELECT the BLOB alongside).
    const row = await db.run(
      SELECT.one.from(EventLogo).columns('sha256', 'mimeType', 'sizeBytes').where({ event_ID: EVENT_ID }),
    );
    expect(row).toBeTruthy();
    expect(row.sha256).toBe(result.sha256);
    expect(row.mimeType).toBe('image/webp');

    // fetchLogo returns the bytes + a quoted-sha256 ETag.
    const fetched = await fetchLogo(EVENT_ID);
    expect(Buffer.isBuffer(fetched.buffer)).toBe(true);
    expect(fetched.buffer.length).toBe(result.sizeBytes);
    expect(fetched.mimeType).toBe('image/webp');
    expect(fetched.etag).toBe(`"${result.sha256}"`);
  });

  it('UPDATE-path: a second upload replaces the row, no duplicate', async () => {
    const db = await cds.connect.to('db');
    const { EventLogo } = cds.entities('com.sap.developers.ims');

    const before = await db.run(SELECT.from(EventLogo).where({ event_ID: EVENT_ID }));
    expect(before.length).toBe(1);

    const png = await FIX('square.png');
    await uploadAndUpsertLogo({ eventID: EVENT_ID, buffer: png, mimeType: 'image/png' });

    const after = await db.run(SELECT.from(EventLogo).where({ event_ID: EVENT_ID }));
    expect(after.length).toBe(1); // 1:1 composition — still exactly one
  });

  it('clearLogo removes the row and resets hasLogo', async () => {
    const db = await cds.connect.to('db');
    const { Events, EventLogo } = cds.entities('com.sap.developers.ims');

    await clearLogo(EVENT_ID);

    const row = await db.run(SELECT.one.from(EventLogo).where({ event_ID: EVENT_ID }));
    expect(row).toBeFalsy();
    const ev = await db.run(SELECT.one.from(Events).columns('hasLogo').where({ ID: EVENT_ID }));
    expect(ev.hasLogo).toBe(false);
    expect(await fetchLogo(EVENT_ID)).toBeNull();
  });
});
