import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Unit tests for the PROD-only NGDS auto-send gating. We stub @sap/cds so these
// run without a live DB — the goal is to prove the two gates (env + DB flag),
// the edge-only-COMPLETED rule, and the task-type allowlist, plus that the
// helper never throws.

const sendSpy = vi.fn();

vi.mock('@sap/cds', () => {
  const log = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() });
  return {
    default: {
      log,
      entities: () => ({ ImsConfig: 'ImsConfig' }),
      connect: { to: async () => ({}) },
    },
  };
});

// Stub the client so we can assert whether a send was attempted.
vi.mock('../../srv/lib/ngds-client.js', () => ({
  sendTaskRecordToNgds: (...args) => sendSpy(...args),
}));

// Control the environment resolution per-test.
let mockEnv = { id: 'prod', label: 'PROD', space: 'prod' };
vi.mock('../../srv/lib/deploy-environment.js', () => ({
  resolveDeployEnvironment: () => mockEnv,
}));

// The helper builds a CQL query via the global SELECT before handing it to
// db.run. In this DB-less unit test the query object is opaque — db.run ignores
// it and returns the configured row — so SELECT just needs to be chainable.
const chainable = new Proxy(function () {}, {
  get: () => chainable,
  apply: () => chainable,
});
globalThis.SELECT = chainable;

// A db.run stub returning the configured ImsConfig flag row.
function makeDb(flagValue) {
  return {
    run: async () => (flagValue === undefined ? undefined : { value: flagValue }),
  };
}

const COMPLETED_TUTORIAL = {
  ID: 'r1', legacyId: 1, taskLegacyId: 10, taskType: 'TUTORIAL',
  status: 'COMPLETED', user_ID: 'u1',
};

let mod;
beforeEach(async () => {
  vi.resetModules();
  sendSpy.mockReset();
  mockEnv = { id: 'prod', label: 'PROD', space: 'prod' };
  mod = await import('../../srv/lib/ngds-autosend.js');
  mod.resetAutoSendFlagCache();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ngds-autosend gating', () => {
  it('sends when PROD + flag on + edge to COMPLETED', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb('true'),
    });
    expect(sendSpy).toHaveBeenCalledOnce();
  });

  it('does NOT send when not in PROD (env gate)', async () => {
    mockEnv = { id: 'dev', label: 'DEV', space: 'dev' };
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb('true'),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT send when DB kill-switch is off/missing', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb(undefined),
    });
    expect(sendSpy).not.toHaveBeenCalled();

    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb('false'),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT re-send when already COMPLETED (edge-only)', async () => {
    await mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'COMPLETED', db: makeDb('true'),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('does NOT send for non-eligible task types (PUZZLE/PETOBERFEST/STEP)', async () => {
    for (const taskType of ['PUZZLE', 'PETOBERFEST', 'STEP', 'CHECKPOINT']) {
      await mod.maybeAutoSendCompletion({
        record: { ...COMPLETED_TUTORIAL, taskType }, priorStatus: 'IN_PROGRESS', db: makeDb('true'),
      });
    }
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('sends for MISSION and GROUP (legacy-eligible types)', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, taskType: 'MISSION' }, priorStatus: null, db: makeDb('true'),
    });
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, taskType: 'GROUP' }, priorStatus: 'IN_PROGRESS', db: makeDb('true'),
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT send when record is not COMPLETED', async () => {
    await mod.maybeAutoSendCompletion({
      record: { ...COMPLETED_TUTORIAL, status: 'IN_PROGRESS' }, priorStatus: null, db: makeDb('true'),
    });
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('never throws when the send client rejects', async () => {
    sendSpy.mockRejectedValueOnce(new Error('ngds down'));
    await expect(mod.maybeAutoSendCompletion({
      record: COMPLETED_TUTORIAL, priorStatus: 'IN_PROGRESS', db: makeDb('true'),
    })).resolves.toBeUndefined();
  });

  it('isAutoSendActive reflects both gates', async () => {
    expect(await mod.isAutoSendActive(makeDb('true'))).toBe(true);
    mod.resetAutoSendFlagCache();
    mockEnv = { id: 'dev', label: 'DEV', space: 'dev' };
    expect(await mod.isAutoSendActive(makeDb('true'))).toBe(false);
  });
});
