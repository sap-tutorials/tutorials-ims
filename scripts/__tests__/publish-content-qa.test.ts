import { describe, it, expect, afterEach } from 'vitest';
import { resolvePublishConfig } from '../publish-content';

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
});
