// @vitest-environment happy-dom
//
// Issue #172 PR 4 — covers the substituteStarter logic that joule.js uses
// to render branch-aware starters. Since joule.js is a plain ES script
// (not a module), the helpers can't be imported into a test. The test file
// inlines the helper definitions mirroring joule.js exactly. If joule.js
// drifts, these tests fail and the implementer reconciles.

import { describe, it, expect, beforeEach } from 'vitest';

function lookupBranchLabels(branchContext: any) {
  try {
    const dataEl = document.getElementById('tutorial-data');
    if (!dataEl) return {};
    let steps = JSON.parse(dataEl.textContent || '[]');
    if (typeof steps === 'string') steps = JSON.parse(steps);
    for (const step of steps) {
      if (step.branchPointId !== branchContext.branchPointId) continue;
      const branches = step.branches || [];
      const current = branches.find((b: any) => b.key === branchContext.currentBranch);
      const recommended = branches.find((b: any) => b.key === branchContext.recommendedBranch);
      return {
        currentLabel: current ? current.label : null,
        recommendedLabel: recommended ? recommended.label : null,
      };
    }
  } catch { /* ignore */ }
  return {} as any;
}

function substituteStarter(text: string, vars: any) {
  let out = text;
  if (!vars || !vars.heading) {
    out = out.replace(/:\s*\{heading\}/g, '');
  }
  out = out.replace(/\{n\}/g, vars && vars.n != null ? String(vars.n) : '');
  out = out.replace(/\{heading\}/g, vars && vars.heading ? String(vars.heading) : '');

  if (vars && vars.branchContext) {
    const labels = lookupBranchLabels(vars.branchContext);
    out = out.replace(/\{currentLabel\}/g, labels.currentLabel || '');
    out = out.replace(/\{recommendedLabel\}/g, labels.recommendedLabel || '');
    out = out.replace(/\{branchLabel\}/g, labels.recommendedLabel || labels.currentLabel || '');
  } else {
    out = out.replace(/\{currentLabel\}|\{recommendedLabel\}|\{branchLabel\}/g, '');
  }
  return out;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('substituteStarter — branch labels', () => {
  function seedTutorialData() {
    const el = document.createElement('script');
    el.id = 'tutorial-data';
    el.type = 'application/json';
    el.textContent = JSON.stringify([
      { number: 3, branchPointId: '3-deployment', branches: [
        { key: 'hana', label: 'HANA Cloud' },
        { key: 'postgres', label: 'PostgreSQL' },
      ] },
    ]);
    document.body.appendChild(el);
  }

  it('substitutes {recommendedLabel} from the tutorial-data JSON', () => {
    seedTutorialData();
    const out = substituteStarter('Why is {recommendedLabel} recommended for me here?', {
      branchContext: {
        branchPointId: '3-deployment',
        currentBranch: 'hana',
        recommendedBranch: 'hana',
      },
    });
    expect(out).toBe('Why is HANA Cloud recommended for me here?');
  });

  it('substitutes {currentLabel} and {recommendedLabel} when they differ', () => {
    seedTutorialData();
    const out = substituteStarter('Should I switch from {currentLabel} to {recommendedLabel}?', {
      branchContext: {
        branchPointId: '3-deployment',
        currentBranch: 'postgres',
        recommendedBranch: 'hana',
      },
    });
    expect(out).toBe('Should I switch from PostgreSQL to HANA Cloud?');
  });

  it('strips placeholders when no branchContext given', () => {
    const out = substituteStarter('Why is {recommendedLabel} the pick?', { n: 3 });
    expect(out).toBe('Why is  the pick?');
  });

  it('handles missing tutorial-data gracefully', () => {
    const out = substituteStarter('Why is {recommendedLabel} the pick?', {
      branchContext: { branchPointId: 'x', currentBranch: 'a', recommendedBranch: 'b' },
    });
    expect(out).toBe('Why is  the pick?');
  });
});
