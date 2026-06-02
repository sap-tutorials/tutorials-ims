import { describe, it, expect } from 'vitest';
import { attachCodeCheckSpecs } from '../../scripts/parsers/codecheck.js';

describe('attachCodeCheckSpecs', () => {
  const baseSteps = () => [
    { number: 1, title: 'Set up' },
    { number: 2, title: 'Implement' },
    { number: 3, title: 'Test yourself' }
  ];

  it('attaches trimmed spec to the matching step number', () => {
    const steps = baseSteps();
    const specs = new Map([
      [2, { stepNumber: 2, goal: 'Add handler', language: 'javascript',
            hints: ['see srv/'], referenceSolution: 'this.before(...)' }]
    ]);
    const sidecar = attachCodeCheckSpecs(steps, specs);
    expect(steps[1].codeCheck).toEqual({
      goal: 'Add handler',
      language: 'javascript',
      hints: ['see srv/'],
      hasReference: true
    });
    expect(steps[1].codeCheck.referenceSolution).toBeUndefined();
    expect(sidecar).toEqual([{
      stepNumber: 2,
      goal: 'Add handler',
      language: 'javascript',
      hints: ['see srv/'],
      referenceSolution: 'this.before(...)'
    }]);
  });

  it('hasReference is false when referenceSolution absent', () => {
    const steps = baseSteps();
    const specs = new Map([[1, { stepNumber: 1, goal: 'G' }]]);
    attachCodeCheckSpecs(steps, specs);
    expect(steps[0].codeCheck.hasReference).toBe(false);
  });

  it('skips specs whose stepNumber does not match any step', () => {
    const steps = baseSteps();
    const specs = new Map([[99, { stepNumber: 99, goal: 'G' }]]);
    const sidecar = attachCodeCheckSpecs(steps, specs);
    expect(steps.every(s => s.codeCheck === undefined)).toBe(true);
    expect(sidecar).toEqual([]);
  });
});
