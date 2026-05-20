import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import cds from '@sap/cds';

// Mock embedding-pipeline so that IF the static import inside admin-service.js
// resolves to this mock, embedSlugs won't call AI Core.
// Note: vi.mock only intercepts static imports in modules loaded BEFORE the mock
// is registered. For modules loaded at runtime via cds.serve(), we instead rely
// on the setImmediate spy to confirm the fire-and-forget callback was scheduled.
vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 0, skipped: 0, failed: 0, lockHeld: false })
}));

import { embedSlugs } from '../../srv/lib/embedding-pipeline.js';

const schemaPath = path.join(process.cwd(), 'db', 'schema.cds');
const CHAT_ID = '00000000-0000-0000-0000-00000000c8a7';

// ---- setup helpers ----------------------------------------------------------

async function setupDb({ ragEnabled = true, manifestStatus = null, slugs = [] } = {}) {
  const { ChatSettings, ContentManifest, ContentFiles } = cds.entities('com.sap.developers.ims');

  await DELETE.from(ChatSettings);
  await INSERT.into(ChatSettings).entries({ ID: CHAT_ID, ragEnabled });

  if (manifestStatus) {
    await INSERT.into(ContentManifest).entries({
      version: 1,
      status: manifestStatus,
      trigger: 'test',
      fileCount: slugs.length,
      totalSizeBytes: 0
    });
    for (const slug of slugs) {
      await INSERT.into(ContentFiles).entries({
        slug,
        version: 1,
        contentHash: 'abc123',
        sizeBytes: 100,
        compressedBytes: 50
      });
    }
  }
}

/** Send an action on the AdminService as a privileged (Admin) user */
async function sendAsAdmin(srv, event) {
  const user = new cds.User.Privileged();
  return srv.tx({ user }, tx => tx.send({ event, entity: 'ChatSettings' }));
}

// ---- tests ------------------------------------------------------------------

describe('AdminService seedEmbeddings action', () => {
  let srv;
  let origSetImmediate;

  beforeEach(async () => {
    origSetImmediate = globalThis.setImmediate;
    vi.clearAllMocks();
    await cds.deploy(schemaPath).to('sqlite::memory:');
    srv = await cds.serve('AdminService').from('./srv/admin-service');
  });

  afterEach(() => {
    globalThis.setImmediate = origSetImmediate;
  });

  it('happy path: returns { queued: true, activeSlugs: N } and schedules fire-and-forget', async () => {
    await setupDb({ ragEnabled: true, manifestStatus: 'ACTIVE', slugs: ['slug-a', 'slug-b', 'slug-c'] });

    // Spy on setImmediate to confirm the fire-and-forget callback was scheduled
    const immediateCallbacks = [];
    globalThis.setImmediate = vi.fn((fn, ...args) => {
      immediateCallbacks.push(fn);
      return origSetImmediate(fn, ...args);
    });

    const result = await sendAsAdmin(srv, 'seedEmbeddings');

    // Verify the return value
    expect(result).toMatchObject({ queued: true, activeSlugs: 3 });

    // Verify the fire-and-forget was scheduled
    expect(immediateCallbacks).toHaveLength(1);

    // Wait for the scheduled callback to run
    await new Promise(resolve => setTimeout(resolve, 50));
  });

  it('rag disabled: rejects with 400 when ragEnabled=false', async () => {
    await setupDb({ ragEnabled: false });

    await expect(
      sendAsAdmin(srv, 'seedEmbeddings')
    ).rejects.toMatchObject({ code: 400 });
  });

  it('no active manifest: rejects with 409', async () => {
    await setupDb({ ragEnabled: true }); // no manifest inserted

    await expect(
      sendAsAdmin(srv, 'seedEmbeddings')
    ).rejects.toMatchObject({ code: 409 });
  });

  it('swallows embedSlugs rejection without unhandled rejection', async () => {
    await setupDb({ ragEnabled: true, manifestStatus: 'ACTIVE', slugs: ['slug-a', 'slug-b'] });

    embedSlugs.mockRejectedValueOnce(new Error('boom'));

    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      let scheduled;
      globalThis.setImmediate = (cb) => { scheduled = cb; return 0; };

      const result = await sendAsAdmin(srv, 'seedEmbeddings');
      expect(result.queued).toBe(true);

      // execute the deferred callback so the rejection actually fires
      await scheduled?.();

      // give the microtask queue a tick to flush
      await new Promise(r => origSetImmediate(r));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
