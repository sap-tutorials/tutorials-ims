import { describe, expect, it, vi } from 'vitest';
import { composeTutorial } from '../parsers/compose';

describe('composeTutorial — tutorial-step-pacing', () => {
  it('derives frontmatter.time from the sum of step times when absent', () => {
    const md = `---
title: Test
parser: v2
---

### Step one {time=5m}

body

### Step two {time=10m}

body
`;
    const result = composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false });
    expect(result.frontmatter.time).toBe(15);
  });

  it('keeps an explicit frontmatter.time when it roughly agrees with step times', () => {
    const md = `---
title: Test
parser: v2
time: 16
---

### Step one {time=5m}

body

### Step two {time=10m}

body
`;
    const result = composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false });
    expect(result.frontmatter.time).toBe(16);
  });

  it('warns step-attr/time-mismatch when frontmatter.time differs from step sum by >25%', () => {
    const md = `---
title: Test
parser: v2
time: 5
---

### Step one {time=10m}

body

### Step two {time=10m}

body
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false });
      const mismatchWarnings = warnSpy.mock.calls.filter(c => /step-attr\/time-mismatch/.test(c[0]));
      expect(mismatchWarnings).toHaveLength(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('throws when every step is marked optional', () => {
    const md = `---
title: Test
parser: v2
---

### Step one {optional}

body

### Step two {optional}

body
`;
    expect(() =>
      composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false })
    ).toThrow(/every step is marked \{optional\}/);
  });

  it('does not throw when at least one step is required', () => {
    const md = `---
title: Test
parser: v2
---

### Step one

body

### Step two {optional}

body
`;
    expect(() =>
      composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false })
    ).not.toThrow();
  });

  it('resolves osOverrides keyed on a step heading using the new attribute syntax', () => {
    const md = `---
title: Test
parser: v2
osOverrides:
  real-step: os
---

### Real Step {time=5m}

[OPTION BEGIN [Windows]]
W
[OPTION END]

[OPTION BEGIN [Mac and Linux]]
ML
[OPTION END]
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'hugo', rewriteImages: false });
      const overrideWarnings = warnSpy.mock.calls.filter(c => /\[compose\] osOverrides/.test(c[0]));
      expect(overrideWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
