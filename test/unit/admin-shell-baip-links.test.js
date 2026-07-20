import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAV = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8')
);
const SHELL = readFileSync(
  join(import.meta.dirname, '../../app/admin-shell/webapp/controller/Shell.controller.js'),
  'utf8'
);

const EXPECTED = {
  baipAiLaunchpad:   'https://tutorial-system.ai-launchpad.prod.eu-central-1.aws.ai-prod.cloud.sap/aic/index.html',
  baipBtpSubaccount: 'https://emea.cockpit.btp.cloud.sap/cockpit/#/globalaccount/a0ec0d63-f690-42ab-8113-9f6567cd897e/subaccount/3c6fa3f1-db8c-4e47-9048-fa8c84b867cb/subaccountoverview',
  baipHanaCloud:     'https://devrel.hana-tooling.ingress.orchestration.prod-eu10.hanacloud.ondemand.com/hcs/sap/hana/cloud/index.html'
};

const TITLES = {
  baipAiLaunchpad:   'AI Launchpad',
  baipBtpSubaccount: 'BTP Subaccount',
  baipHanaCloud:     'HANA Cloud'
};

describe('admin-shell BAIP external-links group', () => {
  const baip = NAV.groups.find(g => g.key === 'baip');

  it('adds a BAIP group as the last sidebar group', () => {
    expect(baip).toBeTruthy();
    expect(baip.title).toBe('BAIP');
    expect(baip.icon).toBeTruthy();
    expect(NAV.groups[NAV.groups.length - 1].key).toBe('baip');
  });

  it('gates the group on the Admin scope', () => {
    expect(baip.requiredScope).toBe('Admin');
  });

  it('has exactly the three expected external-link items', () => {
    const keys = baip.items.map(i => i.key);
    expect(keys).toEqual(['baipAiLaunchpad', 'baipBtpSubaccount', 'baipHanaCloud']);
  });

  it('every item opens in a new tab, is Admin-gated, and points at the exact https URL', () => {
    for (const item of baip.items) {
      expect(item.title).toBe(TITLES[item.key]);
      expect(item.target).toBe('_blank');
      expect(item.requiredScope).toBe('Admin');
      expect(item.href).toBe(EXPECTED[item.key]);
      expect(item.href.startsWith('https://')).toBe(true);
    }
  });

  it('does NOT wire BAIP keys into Shell.controller route/title maps (native anchor nav)', () => {
    for (const key of Object.keys(EXPECTED)) {
      expect(SHELL.includes(key)).toBe(false);
    }
  });
});
