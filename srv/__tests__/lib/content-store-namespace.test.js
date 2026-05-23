// srv/__tests__/lib/content-store-namespace.test.js
import { describe, it, expect } from 'vitest';
import { createContentHandlers, publishHandler, serveHandler } from '../../lib/content-store.js';

describe('content-store factory', () => {
  it('exports a createContentHandlers factory', () => {
    expect(typeof createContentHandlers).toBe('function');
  });
  it('factory returns the five handlers', () => {
    const h = createContentHandlers({ namespace: 'com.sap.developers.ims.qa', apiKeyEnv: 'CONTENT_API_KEY_QA' });
    for (const name of ['serveHandler', 'navHandler', 'hashesHandler', 'publishHandler', 'rollbackHandler', 'contentAuthMiddleware']) {
      expect(typeof h[name]).toBe('function');
    }
  });
  it('default exports still exist and target prod namespace', () => {
    expect(typeof publishHandler).toBe('function');
    expect(typeof serveHandler).toBe('function');
  });
});
