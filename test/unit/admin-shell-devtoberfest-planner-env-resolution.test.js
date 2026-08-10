import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression for the "Devtoberfest Planner always points at DEV" bug.
//
// The env-specific link was resolved from `/-prod\b/.test(hostname)` in
// Component.js. That matches the CF approuter route
// (tutorials-prod-approuter...) but NOT the vanity domain developers.sap.com
// (the live PROD access path). On the vanity host the regex misses and every
// environment silently falls back to the DEV planner URL.
//
// The fix resolves the href from the trustworthy server signal the shell
// already fetches: `/auth/user` returns `environment` derived from the CF
// space_name (srv/lib/deploy-environment.js — chosen precisely because the
// Host header is spoofable). Shell.controller._applyEnvironment feeds that
// into the Component, which prefers it over the hostname sniff.

const COMPONENT = readFileSync(
  join(import.meta.dirname, '../../app/admin-shell/webapp/Component.js'),
  'utf8'
);
const SHELL = readFileSync(
  join(import.meta.dirname, '../../app/admin-shell/webapp/controller/Shell.controller.js'),
  'utf8'
);

const HREF_DEV = 'https://devtoberfest-planner-approuter-dev.cfapps.eu10-005.hana.ondemand.com/';
const HREF_PROD = 'https://devtoberfest-planner-approuter-prod.cfapps.eu10-005.hana.ondemand.com/';

describe('admin-shell Devtoberfest Planner env resolution (server-truth)', () => {
  it('Component exposes a re-runnable resolver + a server-env setter', () => {
    expect(COMPONENT).toContain('_resolveEnvLinks');
    expect(COMPONENT).toContain('setDeployEnvironment');
  });

  it('Component prefers the authoritative server env over the hostname sniff', () => {
    // A boolean stored from /auth/user wins; hostname is only the fallback.
    expect(COMPONENT).toContain('_bEnvIsProd');
    expect(COMPONENT).toMatch(/typeof this\._bEnvIsProd === "boolean"/);
    // The hostname fallback must still exist (correct on CF approuter hosts,
    // and the only signal available before /auth/user resolves).
    expect(COMPONENT).toContain('window.location.hostname');
    expect(COMPONENT).toMatch(/-prod\\b/);
  });

  it('Shell.controller feeds the deploy environment into the Component', () => {
    expect(SHELL).toContain('setDeployEnvironment');
    // Must key off the server env id, not the hostname.
    expect(SHELL).toMatch(/setDeployEnvironment\([^)]*env\.id === "prod"/);
  });

  it('mirrors the resolution precedence: server env wins, hostname is fallback', () => {
    // Mirror of Component._resolveEnvLinks precedence.
    const resolve = (bEnvIsProd, hostname) => {
      const bIsProd = (typeof bEnvIsProd === 'boolean')
        ? bEnvIsProd
        : /-prod\b/.test(hostname);
      return bIsProd ? HREF_PROD : HREF_DEV;
    };

    // THE BUG: PROD reached via the vanity host (no "-prod" in hostname).
    // Server env says prod → must resolve to the PROD planner.
    expect(resolve(true, 'developers.sap.com')).toBe(HREF_PROD);
    // DEV on the vanity/dev host → DEV planner.
    expect(resolve(false, 'developers-dev.sap.com')).toBe(HREF_DEV);

    // Before /auth/user resolves (env unknown) → hostname fallback.
    expect(resolve(undefined, 'tutorial-system-prod-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com')).toBe(HREF_PROD);
    expect(resolve(undefined, 'tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com')).toBe(HREF_DEV);
    expect(resolve(undefined, 'localhost')).toBe(HREF_DEV);
  });
});
