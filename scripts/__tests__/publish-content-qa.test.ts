import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resolvePublishConfig } from '../publish-content';

const SRC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'publish-content.ts'),
  'utf8',
);

describe('publish-content qa channel', () => {
  afterEach(() => {
    delete process.env.CAP_QA_BASE_URL;
    delete process.env.CONTENT_API_KEY_QA;
    delete process.env.CAP_BASE_URL;
    delete process.env.CONTENT_API_KEY;
  });

  it('uses CAP_QA_BASE_URL and CONTENT_API_KEY_QA when channel=qa', () => {
    process.env.CAP_QA_BASE_URL = 'https://qa.example';
    process.env.CONTENT_API_KEY_QA = 'qa-key';
    const cfg = resolvePublishConfig({ channel: 'qa' });
    expect(cfg.baseUrl).toBe('https://qa.example');
    expect(cfg.apiKey).toBe('qa-key');
    expect(cfg.sourceDir).toMatch(/public-qa$/);
    expect(cfg.force).toBe(true);
  });

  it('uses CAP_BASE_URL and CONTENT_API_KEY when channel=prod', () => {
    process.env.CAP_BASE_URL = 'https://prod.example';
    process.env.CONTENT_API_KEY = 'prod-key';
    const originalArgv = process.argv;
    process.argv = process.argv.filter(a => a !== '--force');
    try {
      const cfg = resolvePublishConfig({ channel: 'prod' });
      expect(cfg.baseUrl).toBe('https://prod.example');
      expect(cfg.apiKey).toBe('prod-key');
      expect(cfg.sourceDir).toBe('hugo/public');
      expect(cfg.force).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  // Regression guard: the render-concepts phase (#1327) hits
  // POST /content/publish/render-concepts, which is intentionally NOT
  // registered on srv-qa (allowlisted prod-only in
  // check-srv-qa-route-drift.ts). A full QA rebuild that reaches this phase
  // 404s → abortSession → exit 1, which silently broke every QA
  // merge-to-main publish. The caller MUST gate the phase to channel==='prod'.
  it('gates the render-concepts phase to the prod channel only', () => {
    const gate = SRC.match(
      /if \(!legacyConceptRender && !opts\.slug && channel === 'prod'\) \{/,
    );
    expect(
      gate,
      "render-concepts phase must be gated with `channel === 'prod'` — " +
        'srv-qa has no render-concepts route, so a QA full rebuild would 404 and abort. ' +
        'See scripts/check-srv-qa-route-drift.ts ALLOWLIST_ONLY_ON_SRV.',
    ).not.toBeNull();
  });
});
