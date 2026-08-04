import { describe, it, expect } from 'vitest';
import { resolveChannels } from '@sap-tutorials/cds-alert-notification/lib/routing.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
const cfg = pkg.cds.requires.alerts;

describe('deploy alerts routing config', () => {
  it('declares the dedicated deploy channel', () => {
    expect(cfg.channels).toContain('email:devrel-deploys');
  });
  it('registers the three deploy eventTypes', () => {
    for (const t of ['DeployStarted', 'DeployFinished', 'DeployFailed']) {
      expect(cfg.eventTypes).toContain(t);
    }
  });
  it('routes NOTICE-level deploy chatter to the deploys channel only', () => {
    const ch = resolveChannels('NOTICE', cfg);
    expect(ch).toContain('email:devrel-deploys');
    expect(ch).not.toContain('email:devrel-oncall');
  });
  it('routes ERROR-level failures to BOTH deploys and on-call', () => {
    const ch = resolveChannels('ERROR', cfg);
    expect(ch).toContain('email:devrel-deploys');
    expect(ch).toContain('email:devrel-oncall');
  });
});
