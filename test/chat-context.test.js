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

  // --- advocates kind (issue #564) ---
  const ADVOCATE_FIXTURE = {
    firstName: 'Thomas', lastName: 'Jung', region: 'AMERICAS',
    title: 'Developer Advocate', location: 'Jasper, IN',
    bio: 'Builds CAP samples and decommissions Java IMS one endpoint at a time.',
    topics: [{ slug: 'software-product>cap', label: 'SAP Cloud Application Programming Model' }],
    links: [{ kind: 'LinkedIn', url: 'https://linkedin.com/in/thomas-jung' }]
  };

  it('uses ADVOCATES_PERSONA and includes roster details for kind=advocates', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [ADVOCATE_FIXTURE] }, user);
    expect(out).toMatch(/Developer Advocates page/);
    expect(out).toMatch(/Thomas Jung/);
    expect(out).toMatch(/AMERICAS/);
    expect(out).toMatch(/SAP Cloud Application Programming Model/);
    // bridge-to-advocate instruction present
    expect(out).toMatch(/bridge.*covers/i);
  });

  it('skips RAG_GUIDANCE and PROGRESS_GUIDANCE for kind=advocates', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [ADVOCATE_FIXTURE] }, user);
    expect(out).not.toMatch(/getRelevantSteps/);
    expect(out).not.toMatch(/getUserProgress tool/);
  });

  it('falls back to empty-roster guidance when advocates=[]', () => {
    const out = buildSystemPrompt({ kind: 'advocates', advocates: [] }, user);
    expect(out).toMatch(/has not loaded yet/);
    expect(out).toMatch(/searchTutorials/);
  });

  it('does not throw when advocates is not an array', () => {
    expect(() =>
      buildSystemPrompt({ kind: 'advocates', advocates: 'not-an-array' }, user)
    ).not.toThrow();
    const out = buildSystemPrompt({ kind: 'advocates', advocates: 'not-an-array' }, user);
    expect(out).toMatch(/has not loaded yet/);
  });

  it('regression: admin path still includes RAG_GUIDANCE', () => {
    const out = buildSystemPrompt({ kind: 'admin', tool: 'analytics-builder' }, user);
    expect(out).toMatch(/getRelevantSteps/);
  });
});

describe('buildSystemPrompt — BRANCHING_GUIDANCE', () => {
  it('appends BRANCHING_GUIDANCE on tutorial pages with branchContext', () => {
    const prompt = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Configure database',
      slug: 'configure-database',
      currentStep: 3,
      branchContext: {
        branchPointId: '3-deployment',
        groupKey: 'deployment',
        currentBranch: 'hana',
        recommendedBranch: 'hana',
      },
    }, null);
    expect(prompt).toMatch(/getBranchRecommendation/);
  });

  it('does NOT append BRANCHING_GUIDANCE on tutorial pages WITHOUT branchContext', () => {
    const prompt = buildSystemPrompt({
      kind: 'tutorial',
      title: 'Plain tutorial',
      slug: 'plain',
      currentStep: 1,
    }, null);
    expect(prompt).not.toMatch(/getBranchRecommendation/);
  });

  it('appends BRANCHING_GUIDANCE on mission pages with altGroupsCount > 0', () => {
    const prompt = buildSystemPrompt({
      kind: 'mission',
      title: 'BTP CAP onboarding',
      altGroupsCount: 1,
    }, null);
    expect(prompt).toMatch(/getBranchRecommendation/);
  });

  it('does NOT append BRANCHING_GUIDANCE on mission pages with altGroupsCount: 0 or absent', () => {
    const prompt = buildSystemPrompt({
      kind: 'mission',
      title: 'No-branches mission',
    }, null);
    expect(prompt).not.toMatch(/getBranchRecommendation/);
  });
});
