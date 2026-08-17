// Unit tests for #1859: buildSystemPrompt injects the What's New guidance layer
// on the learner path only when ChatSettings.whatsNewEnabled is true, and the
// base persona no longer hard-refuses platform "what's new" questions.

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

const user = { firstName: 'Tom' };

describe('buildSystemPrompt — What\'s New guidance', () => {
  it('includes the getWhatsNew guidance on the learner path when whatsNewEnabled=true', async () => {
    const out = await buildSystemPrompt({ kind: 'generic' }, user, { whatsNewEnabled: true });
    expect(out).toMatch(/getWhatsNew/);
    expect(out).toMatch(/What's New page/);
  });

  it('omits the guidance when whatsNewEnabled=false', async () => {
    const out = await buildSystemPrompt({ kind: 'generic' }, user, { whatsNewEnabled: false });
    expect(out).not.toMatch(/getWhatsNew/);
  });

  it('omits the guidance when settings is null', async () => {
    const out = await buildSystemPrompt({ kind: 'generic' }, user, null);
    expect(out).not.toMatch(/getWhatsNew/);
  });

  it('does NOT inject the guidance on the admin path even when the flag is true', async () => {
    const out = await buildSystemPrompt({ kind: 'admin' }, user, { whatsNewEnabled: true });
    expect(out).not.toMatch(/getWhatsNew/);
  });

  it('the base learner persona now scopes in platform updates instead of refusing', async () => {
    const out = await buildSystemPrompt({ kind: 'generic' }, user, { whatsNewEnabled: true });
    expect(out).toMatch(/what's new or recently changed on this tutorial platform/i);
    // still a tutorials assistant — redirect language for truly unrelated topics remains
    expect(out).toMatch(/I can only help with SAP tutorials/);
  });
});
