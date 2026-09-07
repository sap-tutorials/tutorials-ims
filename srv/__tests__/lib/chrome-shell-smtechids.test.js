// srv/__tests__/lib/chrome-shell-smtechids.test.js
import { describe, it, expect } from 'vitest';
import { composeShell } from '../../lib/chrome-shell.js';

const halves = {
  before: '<head><meta name="description" content="x"></head>',
  after: '</body>',
};

describe('composeShell sm_tech_ids', () => {
  it('inserts one meta after the description meta when smTechIds present', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x',
      smTechIds: ['111', '222'],
    });
    expect(out).toContain('<meta name="sm_tech_ids" content="en-US,111,222">');
    // exactly one occurrence
    expect(out.match(/name="sm_tech_ids"/g)).toHaveLength(1);
  });

  it('emits nothing when smTechIds is absent', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x',
    });
    expect(out).not.toContain('sm_tech_ids');
  });

  it('emits nothing when smTechIds is empty', () => {
    const out = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: [],
    });
    expect(out).not.toContain('sm_tech_ids');
  });

  it('is idempotent — re-composing does not duplicate the tag', () => {
    const once = composeShell(halves, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: ['111'],
    });
    const twice = composeShell({ before: once.replace('<main></main></body>', ''), after: '</body>' }, '<main></main>', {
      kind: 'group', slug: 'group-x', title: 'X', description: 'x', smTechIds: ['111'],
    });
    expect(twice.match(/name="sm_tech_ids"/g)).toHaveLength(1);
  });
});
