import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../srv/lib/chat-context.js';

describe('buildSystemPrompt', () => {
  const user = { firstName: 'Tom', lastName: 'Jung' };

  it('always includes the Joule persona and scope guard', () => {
    const out = buildSystemPrompt({ kind: 'generic' }, user);
    expect(out).toMatch(/You are Joule/);
    expect(out).toMatch(/SAP tutorials/);
  });

  it('injects tutorial details for kind=tutorial', () => {
    const out = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Build with CAP',
      description: 'Hands-on intro',
      tags: ['cap', 'nodejs'],
      stepCount: 7,
      currentStep: 3
    }, user);
    expect(out).toMatch(/You are Joule/);
    expect(out).toMatch(/Build with CAP/);
    expect(out).toMatch(/step 3/i);
    expect(out).toMatch(/cap, nodejs/);
  });

  it('directs the model to call searchTutorials first on kind=search', () => {
    const out = buildSystemPrompt({ kind: 'search', query: 'hana', filters: ['hana'] }, user);
    expect(out).toMatch(/searchTutorials/);
    expect(out).toMatch(/hana/);
  });

  it('lists contained tutorials for mission/group', () => {
    const out = buildSystemPrompt({
      kind: 'mission',
      title: 'Become a CAP dev',
      tutorials: [{ title: 'A' }, { title: 'B' }]
    }, user);
    expect(out).toMatch(/Become a CAP dev/);
    expect(out).toMatch(/A.*B/s);
  });

  it('omits the user name when no user is supplied', () => {
    const out = buildSystemPrompt({ kind: 'generic' }, null);
    expect(out).not.toMatch(/Tom/);
  });

  it('handles missing optional tutorial fields gracefully', () => {
    expect(() => buildSystemPrompt({ kind: 'tutorial', title: 'X' }, user)).not.toThrow();
    const out = buildSystemPrompt({ kind: 'tutorial' }, user);
    expect(out).not.toMatch(/unknown/);
    expect(out).not.toMatch(/undefined/);
  });

  it('omits untitled items from mission/group tutorial lists', () => {
    const out = buildSystemPrompt({
      kind: 'mission',
      title: 'Mixed mission',
      tutorials: [{ title: 'A' }, {}]
    }, user);
    expect(out).not.toMatch(/undefined/);
    expect(out).toMatch(/A/);
  });

  it('preserves the blank-line layer separator between persona and page layer', () => {
    const out = buildSystemPrompt({ kind: 'generic' }, user);
    expect(out).toMatch(/\n\n/);
  });
});
