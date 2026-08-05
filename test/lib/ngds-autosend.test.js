import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Unit tests for the PROD-only NGDS auto-send gating. We stub @sap/cds so these
// run without a live DB — the goal is to prove the two env/flag gates, the
// edge-only-COMPLETED rule, the task-type allowlist, the historical-completion
// guards (migration stamp + cutover epoch), the identity gate, and that the
// helper never throws.

const sendSpy = vi.fn();

vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });
  return {
    default: {
      log,
      entities: () => ({
        ImsConfig: { name: 'ImsConfig' },
        Users: { name: 'Users' },
      }),
      connect: { to: async () => ({}) },
    },
  };
});

// Stub the client so we can assert whether a send was attempted.
vi.mock('../../srv/lib/ngds-client.js', () => ({
  sendTaskRecordToNgds: (...args) => sendSpy(...args),
}));

// Spy on metrics counters so we can assert the skip reasons.
const counterSpy = vi.fn();
vi.mock('../../srv/lib/metrics.js', () => ({
  counter: (...args) => counterSpy(...args),
}));

// Control the environment resolution per-test.
let mockEnv = { id: 'prod', label: 'PROD', space: 'prod' };
vi.mock('../../srv/lib/deploy-environment.js', () => ({
  resolveDeployEnvironment: () => mockEnv,
}));

// SELECT builder that records which entity + where a query targets so the
// db.run stub below can route flag / epoch / user lookups distinctly. The
// helper chains .one.from(entity).columns(...).where({...}) → a plain object.
globalThis.SELECT = {
  one: {
    from(entity) {
      const q = { __entity: entity?.name || entity, __where: null };
      const api = {
        columns() { return api; },
        where(w) { q.__where = w; return q; },
      };
      return api;
    },
  },
};

// Build a db whose run() routes by the recorded query:
//   - ImsConfig + key 'ngds.autosend.enabled' → { value: flagValue }
//   - ImsConfig + key 'ngds.autosend.epoch'    → { value: epochValue }
//   - Users                                     → { sapId }
function makeDb(opts = {}) {
  const { flag, epoch } = opts;
  // Distinguish "omit sapId" (explicit undefined → no user row) from "not
  // specified" (default to a canonical P-number). A destructuring default would
  // coerce an explicit `undefined` back to the default, so check the key.
  const sapId = 'sapId' in opts ? opts.sapId : 'P0001234567';
  return {
    run: async (q) => {
      const entity = q?.__entity;
      const key = q?.__where?.key;
      if (entity === 'ImsConfig' && key === 'ngds.autosend.enabled') {
        return flag === undefined ? undefined : { value: flag };
      }
      if (entity === 'ImsConfig' && key === 'ngds.autosend.epoch') {
        return epoch === undefined ? undefined : { value: epoch };
      }
      if (entity === 'Users') {
        return sapId === undefined ? undefined : { sapId };
      }
      return undefined;
    },
  };
}

const COMPLETED_TUTORIAL = {
  ID: 'r1', legacyId: 1, taskLegacyId: 10, taskType: 'TUTORIAL',
  status: 'COMPLETED', user_ID: 'u1', createdBy: 'alice@example.com',
  completionDate: '2026-08-04T12:00:00Z',
};

let mod;
beforeEach(async () => {
  vi.resetModules();
  sendSpy.mockReset();
  counterSpy.mockReset();
  mockEnv = { id: 'prod', label: 'PROD', space: 'prod' };
  mod = await import('../../srv/lib/ngds-autosend.js');
  mod.resetAutoSendFlagCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ngds-autosend gating', () => {
  it('sends when PROD + flag on + edge to COMPLETED + resolvable identity', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.sent');
  });

  it('does NOT send when not in PROD (env gate)', async () => {
    mockEnv = { id: 'dev', label: 'DEV', space: 'dev' };
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT send when DB kill-switch is off/missing', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: undefined }),
    });
    expect(sendSpy).not.toHaveBeenCalled();

    mod.resetAutoSendFlagCache();
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'false' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT re-send when already COMPLETED (edge-only)', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'COMPLETED', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT send for non-eligible task types (PUZZLE/PETOBERFEST/STEP)', async () => {
    for (const taskType of ['PUZZLE', 'PETOBERFEST', 'STEP', 'CHECKPOINT']) {
      await mod.maybeAutoSendCompletion({
        record: { ...COMPLETED_TUTORIAL, taskType }, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
      });
    }
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends for MISSION and GROUP (legacy-eligible types)', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, taskType: 'MISSION' }, priorStatus: null, db: makeDb({ flag: 'true' }),
    });
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, taskType: 'GROUP' }, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT send when record is not COMPLETED', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, status: 'IN_PROGRESS' }, priorStatus: null, db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  // --- Historical-completion guards ---

  it('does NOT send migration-stamped rows (legacy already credited)', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, createdBy: 'migration' },
      priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.skipped.migration');
  });

  it('does NOT send completions before the cutover epoch', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, completionDate: '2026-07-01T00:00:00Z' },
      priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', epoch: '2026-08-01T00:00:00Z' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.skipped.pre_epoch');
  });

  it('sends completions at/after the cutover epoch', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, completionDate: '2026-08-04T00:00:00Z' },
      priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', epoch: '2026-08-01T00:00:00Z' }),
    });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  // --- Identity gate ---

  it('does NOT send when sapId is missing', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', sapId: undefined }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.skipped.no_identity');
  });

  it('does NOT send when sapId is a non-canonical hex community id', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', sapId: '64195477ec454b1c917b9151cca0e1db' }),
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(counterSpy).toHaveBeenCalledWith('ngds.autosend.skipped.no_identity');
  });

  it('sends for canonical S-number and I-number uids', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', sapId: 'S0027841239' }),
    });
    mod.resetAutoSendFlagCache();
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS',
      db: makeDb({ flag: 'true', sapId: 'I012345' }),
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('never throws when the send client rejects', async () => {
    sendSpy.mockRejectedValueOnce(new Error('ngds down'));
    await expect(mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb({ flag: 'true' }),
    })).resolves.toBeUndefined();
  });

  it('isAutoSendActive reflects both gates', async () => {
    expect(await mod.isAutoSendActive(makeDb({ flag: 'true' }))).toBe(true);
    mod.resetAutoSendFlagCache();
    mockEnv = { id: 'dev', label: 'DEV', space: 'dev' };
    expect(await mod.isAutoSendActive(makeDb({ flag: 'true' }))).toBe(false);
  });

  it('resolveAutoSendEpoch returns null for unset/invalid, ms for valid', async () => {
    expect(await mod.resolveAutoSendEpoch(makeDb({ epoch: undefined }))).toBeNull();
    mod.resetAutoSendFlagCache();
    expect(await mod.resolveAutoSendEpoch(makeDb({ epoch: 'not-a-date' }))).toBeNull();
    mod.resetAutoSendFlagCache();
    expect(await mod.resolveAutoSendEpoch(makeDb({ epoch: '2026-08-01T00:00:00Z' })))
      .toBe(new Date('2026-08-01T00:00:00Z').getTime());
  });
});
