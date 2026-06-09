import { describe, expect, it, vi } from 'vitest';
import { composeTutorial } from '../parsers/compose';

describe('composeTutorial — osOverrides unmatched-key warning', () => {
  it('warns when an osOverrides key does not match any step heading', () => {
    const md = `---
title: Test
parser: v2
osOverrides:
  step-typo: os
---

### Real Step

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
      expect(overrideWarnings).toHaveLength(1);
      const msg = overrideWarnings[0][0];
      expect(msg).toMatch(/osOverrides/);
      expect(msg).toMatch(/step-typo/);
      expect(msg).toMatch(/"t"/);  // tutorial slug in quotes
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('does NOT warn when all osOverrides keys match step headings', () => {
    const md = `---
title: Test
parser: v2
osOverrides:
  real-step: regular
---

### Real Step

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

  it('does NOT warn for vitepress target (osOverrides is hugo-only)', () => {
    const md = `---
title: Test
parser: v2
osOverrides:
  step-typo: os
---

### Real Step

[OPTION BEGIN [Windows]]
W
[OPTION END]
`;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      composeTutorial(md, { repo: 'r', branch: 'b', slug: 't', target: 'vitepress', rewriteImages: false });
      const overrideWarnings = warnSpy.mock.calls.filter(c => /\[compose\] osOverrides/.test(c[0]));
      expect(overrideWarnings).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
