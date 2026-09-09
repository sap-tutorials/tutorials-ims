// test/unit/alert-builders.test.js
// Unit tests for the pure alert-decision builders added for issue #1718
// (Additional Alerts). These mirror buildRetryAlerts (ngds-retry.js): they
// take a run's findings and return the ANS alert envelope(s) to raise, with no
// I/O — so thresholds and severities are testable in isolation. The job bodies
// wrap the returned alert(s) with category:'ALERT' + resource before handing
// them to the fail-open alerting.raise().

import { describe, it, expect } from 'vitest';
import { buildSecretExpiryAlerts } from '../../srv/jobs/secret-expiry-check.js';
import { buildBrokenLinksAlert } from '../../srv/jobs/homepage-link-health.js';
import { buildPublishStuckAlert } from '../../srv/jobs/cleanup.js';
import { buildChannelSubmissionAlert } from '../../srv/channel-submission-service.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('buildSecretExpiryAlerts (#1718)', () => {
  it('returns no alert when nothing is critical or warning', () => {
    expect(buildSecretExpiryAlerts({ critical: 0, warning: 0 })).toEqual([]);
    expect(buildSecretExpiryAlerts()).toEqual([]);
    // INFO-tier alone (counted elsewhere) must stay silent on the alert channel.
    expect(buildSecretExpiryAlerts({ critical: 0, warning: 0, criticalKeys: [], warningKeys: [] })).toEqual([]);
  });

  it('escalates to ERROR when any secret is expired/missing (critical)', () => {
    const [alert] = buildSecretExpiryAlerts({ critical: 2, warning: 1, criticalKeys: ['A', 'B'], warningKeys: ['C'] });
    expect(alert.eventType).toBe('SecretExpiringSoon');
    expect(alert.severity).toBe('ERROR');
    expect(alert.subject).toContain('2 expired or missing');
    expect(alert.subject).toContain('1 expiring within');
    expect(alert.body).toContain('A, B');
    expect(alert.body).toContain('C');
  });

  it('uses WARNING severity when only warning-tier secrets exist', () => {
    const [alert] = buildSecretExpiryAlerts({ critical: 0, warning: 3, warningKeys: ['X', 'Y', 'Z'] });
    expect(alert.severity).toBe('WARNING');
    expect(alert.subject).toContain('3 expiring within');
    expect(alert.subject).not.toContain('expired or missing');
  });
});

describe('buildBrokenLinksAlert (#1718)', () => {
  it('returns null when no links are broken', () => {
    expect(buildBrokenLinksAlert({ broken: 0 })).toBe(null);
    expect(buildBrokenLinksAlert()).toBe(null);
  });

  it('returns a WARNING alert with a shelf/for-you breakdown when links are broken', () => {
    const alert = buildBrokenLinksAlert({
      broken: 3,
      shelves: { ok: 5, slow: 0, broken: 2, skipped: 0 },
      forYou: { ok: 8, slow: 1, broken: 1, skipped: 2 },
    });
    expect(alert.eventType).toBe('HomepageLinksBroken');
    expect(alert.severity).toBe('WARNING');
    expect(alert.subject).toContain('3 broken');
    expect(alert.body).toContain('shelves: 2');
    expect(alert.body).toContain('for-you: 1');
  });
});

describe('buildPublishStuckAlert (#1718)', () => {
  it('returns null when nothing was reaped', () => {
    expect(buildPublishStuckAlert({ reaped: 0 })).toBe(null);
    expect(buildPublishStuckAlert()).toBe(null);
  });

  it('returns a WARNING alert listing reaped session ids', () => {
    const alert = buildPublishStuckAlert({ reaped: 2, sessionIds: ['s1', 's2', null] });
    expect(alert.eventType).toBe('PublishStuck');
    expect(alert.severity).toBe('WARNING');
    expect(alert.subject).toContain('2 manifest(s)');
    // null session ids (legacy single-shot publishes) are filtered out.
    expect(alert.body).toContain('s1, s2');
    expect(alert.body).not.toContain('null');
  });
});

describe('buildChannelSubmissionAlert (#2198)', () => {
  it('returns null when the submission has no kind', () => {
    expect(buildChannelSubmissionAlert({})).toBe(null);
    expect(buildChannelSubmissionAlert()).toBe(null);
  });

  it('builds a NOTICE alert naming the kind and submitter', () => {
    const alert = buildChannelSubmissionAlert({ kind: 'ADD', submitterId: 'dev-42', rationale: 'great channel' });
    expect(alert.eventType).toBe('ChannelSubmissionPending');
    expect(alert.severity).toBe('NOTICE');
    expect(alert.subject).toContain('ADD');
    expect(alert.body).toContain('dev-42');
    expect(alert.body).toContain('Rationale: great channel');
    expect(alert.body).toContain('/admin-ui/#ChannelSubmissions-manage');
  });

  it('mentions the target channel for EDIT/REMOVE and omits an empty rationale', () => {
    const alert = buildChannelSubmissionAlert({ kind: 'EDIT', submitterId: 'dev-1', targetChannel_ID: 'chan-9', rationale: '   ' });
    expect(alert.subject).toContain('EDIT');
    expect(alert.body).toContain('target channel chan-9');
    expect(alert.body).not.toContain('Rationale:');
  });

  it('caps a long rationale at 300 chars', () => {
    const long = 'x'.repeat(500);
    const alert = buildChannelSubmissionAlert({ kind: 'ADD', submitterId: 'd', rationale: long });
    expect(alert.body).toContain('x'.repeat(300));
    expect(alert.body).not.toContain('x'.repeat(301));
  });

  it('is registered in the alerts eventTypes allow-list', () => {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.cds.requires.alerts.eventTypes).toContain('ChannelSubmissionPending');
  });
});
