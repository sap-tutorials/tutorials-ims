import { describe, it, expect } from 'vitest';
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
