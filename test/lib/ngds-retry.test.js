import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildRetryAlerts, BACKLOG_THRESHOLD } from '../../srv/jobs/ngds-retry.js';

describe('buildRetryAlerts', () => {
  it('returns no alerts on a healthy run', () => {
    expect(buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: 0 })).toEqual([]);
  });

  it('raises an ERROR NgdsSendExhausted alert when messages are permanently dropped', () => {
    const alerts = buildRetryAlerts({ failed: 3, exhausted: 2, pendingRemaining: 5 });
    const exhausted = alerts.find(a => a.eventType === 'NgdsSendExhausted');
    expect(exhausted).toBeDefined();
    expect(exhausted.severity).toBe('ERROR');
    expect(exhausted.subject).toContain('2');
  });

  it('raises a WARNING NgdsBacklog alert when retries fail this run', () => {
    const alerts = buildRetryAlerts({ failed: 1, exhausted: 0, pendingRemaining: 1 });
    const backlog = alerts.find(a => a.eventType === 'NgdsBacklog');
    expect(backlog).toBeDefined();
    expect(backlog.severity).toBe('WARNING');
  });

  it('raises NgdsBacklog on a large backlog even when no retry failed this run', () => {
    const alerts = buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: BACKLOG_THRESHOLD });
    expect(alerts.some(a => a.eventType === 'NgdsBacklog')).toBe(true);
  });

  it('does not raise NgdsBacklog just below threshold with no failures', () => {
    const alerts = buildRetryAlerts({ failed: 0, exhausted: 0, pendingRemaining: BACKLOG_THRESHOLD - 1 });
    expect(alerts.some(a => a.eventType === 'NgdsBacklog')).toBe(false);
  });

  it('can raise both alerts in one run', () => {
    const alerts = buildRetryAlerts({ failed: 5, exhausted: 1, pendingRemaining: 25 });
    expect(alerts.map(a => a.eventType).sort()).toEqual(['NgdsBacklog', 'NgdsSendExhausted']);
  });
});

const raiseSpy = vi.fn();
const gaugeSpy = vi.fn();
const counterSpy = vi.fn();
const postPayloadSpy = vi.fn();

vi.mock('../../srv/lib/alerting.js', () => ({ raise: (...a) => raiseSpy(...a) }));
vi.mock('../../srv/lib/metrics.js', () => ({
  gauge: (...a) => gaugeSpy(...a),
  counter: (...a) => counterSpy(...a),
}));
vi.mock('../../srv/lib/pipeline-log.js', () => ({ logJobItem: vi.fn() }));
vi.mock('../../srv/lib/ngds-client.js', () => ({ postPayload: (...a) => postPayloadSpy(...a) }));

vi.mock('@sap/cds', () => ({
  default: {
    log: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    entities: () => ({ NGDSFailedMessages: { name: 'NGDSFailedMessages' } }),
  },
}));

// Minimal ql globals used by retryNgds: SELECT.from(e).where(w) is awaited to a
// row array; UPDATE(e,id).set(o) and DELETE.from(e,id) resolve to undefined.
let pendingRows = [];
globalThis.SELECT = { from: () => ({ where: () => Promise.resolve(pendingRows) }) };
globalThis.UPDATE = () => ({ set: async () => undefined });
globalThis.DELETE = { from: async () => undefined };

describe('retryNgds wiring (alerts + gauges)', () => {
  let retryNgds;
  beforeEach(async () => {
    vi.resetModules();
    raiseSpy.mockReset(); gaugeSpy.mockReset(); counterSpy.mockReset(); postPayloadSpy.mockReset();
    ({ retryNgds } = await import('../../srv/jobs/ngds-retry.js'));
  });
  afterEach(() => vi.clearAllMocks());

  it('raises ERROR + WARNING and gauges pending when a message exhausts retries', async () => {
    pendingRows = [
      { ID: 'a', payload: '{}', retryCount: 9, maxRetries: 10 }, // will exhaust after this fail
    ];
    postPayloadSpy.mockRejectedValue(new Error('RBAC: access denied'));
    await retryNgds('log-1');
    const events = raiseSpy.mock.calls.map(c => c[0].eventType);
    expect(events).toContain('NgdsSendExhausted');
    expect(events).toContain('NgdsBacklog');
    // pendingRemaining = pending.length(1) - retried(0) - exhausted(1) = 0
    expect(gaugeSpy).toHaveBeenCalledWith('ngds.failed_messages.pending', 0);
    expect(counterSpy).toHaveBeenCalledWith('ngds.retry.failed', 1);
    expect(counterSpy).toHaveBeenCalledWith('ngds.retry.exhausted', 1);
  });

  it('raises no alert and gauges 0 pending when all sends succeed', async () => {
    pendingRows = [{ ID: 'b', payload: '{}', retryCount: 0, maxRetries: 10 }];
    postPayloadSpy.mockResolvedValue(undefined); // success, no throw
    await retryNgds('log-2');
    expect(raiseSpy).not.toHaveBeenCalled();
    expect(gaugeSpy).toHaveBeenCalledWith('ngds.failed_messages.pending', 0);
    expect(counterSpy).not.toHaveBeenCalledWith('ngds.retry.failed', expect.anything());
    expect(counterSpy).not.toHaveBeenCalledWith('ngds.retry.exhausted', expect.anything());
  });
});
