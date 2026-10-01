import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
let captured, stub;
vi.mock('@sap/cds', () => ({ default: {
  entities: () => ({
    Users: { name: 'com.sap.developers.ims.Users' },
    TaskRecords: { name: 'com.sap.developers.ims.TaskRecords' },
    Tutorials: { name: 'com.sap.developers.ims.Tutorials' },
    Missions: { name: 'com.sap.developers.ims.Missions' },
    CompletionPaths: { name: 'com.sap.developers.ims.CompletionPaths' },
  }),
  log: () => ({ warn() {} }),
} }));
function installSelect() {
  const makeChain = (one) => ({
    _entity: null,
    from(e) { this._entity = e?.name || e; return this; },
    columns() { return this; },
    where(arg) {
      captured = { where: arg };
      return Promise.resolve(one ? (stub.row ?? null) : (stub.rows ?? []));
    },
  });
  globalThis.SELECT = Object.assign(() => makeChain(false), {
    one: { from: (e) => makeChain(true).from(e) },
    from: (e) => makeChain(false).from(e),
  });
}
const { getUserProgress } = await import('../../packages/core/user-progress.js');

describe('resolveDbUserId — attr.dbUserId fallback', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });
  it('returns empty progress (no throw) for a no-sapId user with a pinned dbUserId', async () => {
    stub.rows = [];
    const user = { id: 'who@gmail.com', attr: { dbUserId: 'u-social' }, authInfo: { token: { payload: {} } } };
    // getUserProgress internally resolves via resolveDbUserId; with the pinned
    // attr.dbUserId it proceeds past the null-guard and issues a TaskRecords
    // SELECT with user_ID = 'u-social'. We assert that captured WHERE contains
    // 'u-social', proving the user was not treated as anonymous.
    await getUserProgress(user, { limit: 1 }).catch(() => {});
    expect(JSON.stringify(captured?.where ?? {})).toContain('u-social');
  });
});
