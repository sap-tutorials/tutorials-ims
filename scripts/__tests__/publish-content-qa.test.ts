import { describe, it, expect } from 'vitest';
import { resolvePublishConfig } from '../publish-content';

describe('publish-content qa channel', () => {
  it('uses CAP_QA_BASE_URL and CONTENT_API_KEY_QA when channel=qa', () => {
    process.env.CAP_QA_BASE_URL = 'https://qa.example';
    process.env.CONTENT_API_KEY_QA = 'qa-key';
    const cfg = resolvePublishConfig({ channel: 'qa' });
    expect(cfg.baseUrl).toBe('https://qa.example');
    expect(cfg.apiKey).toBe('qa-key');
    expect(cfg.sourceDir).toMatch(/public-qa$/);
    expect(cfg.force).toBe(true);
  });
});
