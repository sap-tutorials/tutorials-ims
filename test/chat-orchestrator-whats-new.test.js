// Unit tests for #1859: chat-orchestrator flag-gates the getWhatsNew tool on
// ChatSettings.whatsNewEnabled and routes dispatch to the handler.
//
// buildToolRegistry / dispatchTool are pure/sync seams — no CAP boot, no DB.
// dispatchTool('getWhatsNew') reads the committed hugo/data/whats_new.json (or
// the srv snapshot) via the tool's own fallback, so it returns real data here.

import { describe, it, expect } from 'vitest';
import { buildToolRegistry, dispatchTool } from '../srv/lib/chat-orchestrator.js';

const has = (tools, name) => tools.some(t => t.function?.name === name);

describe('chat-orchestrator whatsNewEnabled gating', () => {
  it('registers getWhatsNew on the learner path when the flag is true', () => {
    const tools = buildToolRegistry({ settings: { whatsNewEnabled: true } });
    expect(has(tools, 'getWhatsNew')).toBe(true);
  });

  it('does NOT register getWhatsNew when the flag is false', () => {
    const tools = buildToolRegistry({ settings: { whatsNewEnabled: false } });
    expect(has(tools, 'getWhatsNew')).toBe(false);
  });

  it('does NOT register getWhatsNew when settings is missing', () => {
    const tools = buildToolRegistry({});
    expect(has(tools, 'getWhatsNew')).toBe(false);
  });

  it('does NOT register getWhatsNew on the admin path even when the flag is true', () => {
    const tools = buildToolRegistry({
      settings: { whatsNewEnabled: true },
      pageContext: { kind: 'admin' },
      isAdmin: true,
    });
    expect(has(tools, 'getWhatsNew')).toBe(false);
  });

  it('does NOT register getWhatsNew on the devtoberfest/advocates/puzzle early-return paths', () => {
    for (const kind of ['devtoberfest', 'advocates', 'puzzle']) {
      const tools = buildToolRegistry({ settings: { whatsNewEnabled: true }, pageContext: { kind } });
      expect(has(tools, 'getWhatsNew')).toBe(false);
    }
  });
});

describe('dispatchTool getWhatsNew', () => {
  it('routes to the handler and returns a What\'s New payload', async () => {
    const out = await dispatchTool('getWhatsNew', { limit: 3 }, null);
    expect(out).toBeTruthy();
    expect(out.error).toBeUndefined();
    expect(out.pageUrl).toBe('/whats-new/');
    expect(Array.isArray(out.entries)).toBe(true);
  });
});
