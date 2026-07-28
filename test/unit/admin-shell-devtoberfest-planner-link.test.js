import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const NAV = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../app/admin-shell/webapp/model/navigation.json'), 'utf8')
);
const COMPONENT = readFileSync(
  join(import.meta.dirname, '../../app/admin-shell/webapp/Component.js'),
  'utf8'
);

const HREF_DEV = 'https://devtoberfest-planner-approuter-dev.cfapps.eu10-005.hana.ondemand.com/';
const HREF_PROD = 'https://devtoberfest-planner-approuter-prod.cfapps.eu10-005.hana.ondemand.com/';

describe('admin-shell Devtoberfest Planner external link', () => {
  const group = NAV.groups.find(g => g.key === 'devtoberfestGroup');
  const planner = group?.items.find(i => i.key === 'devtoberfestPlanner');

  it('adds the planner item under the Devtoberfest group', () => {
    expect(group).toBeTruthy();
    expect(planner).toBeTruthy();
    expect(planner.title).toBe('Devtoberfest Planner');
  });

  it('opens in a new tab and carries env-specific DEV/PROD URLs (no static href)', () => {
    expect(planner.target).toBe('_blank');
    expect(planner.hrefDev).toBe(HREF_DEV);
    expect(planner.hrefProd).toBe(HREF_PROD);
    // href must be resolved at runtime, not baked into the shared bundle.
    expect(planner.href).toBeUndefined();
    expect(planner.hrefDev.startsWith('https://')).toBe(true);
    expect(planner.hrefProd.startsWith('https://')).toBe(true);
  });

  it('Component resolves hrefDev/hrefProd -> href from the approuter hostname', () => {
    expect(COMPONENT).toContain('hrefDev');
    expect(COMPONENT).toContain('hrefProd');
    expect(COMPONENT).toMatch(/-prod\\b/);
    expect(COMPONENT).toContain('window.location.hostname');
  });

  it('mirrors the DEV/PROD selection logic used at runtime', () => {
    const pick = (hostname) => {
      const bIsProd = /-prod\b/.test(hostname);
      return bIsProd ? HREF_PROD : HREF_DEV;
    };
    expect(pick('tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com')).toBe(HREF_PROD);
    expect(pick('tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com')).toBe(HREF_DEV);
    expect(pick('localhost')).toBe(HREF_DEV);
  });
});
