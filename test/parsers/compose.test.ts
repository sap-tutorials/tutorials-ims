import { describe, it, expect } from 'vitest';
import { composeTutorial } from '../../scripts/parsers/compose.js';

describe('composeTutorial', () => {
  it('extracts frontmatter, resolves image URLs, parses V2 steps', () => {
    const raw = `---
title: Hello
description: A test
parser: v2
time: 5
primary_tag: software-product>sap-business-technology-platform
---

You will learn:
- A
- B

### Step One
Body of step one.

![alt](./images/foo.png)

### Step Two
Body of step two.
`;
    const result = composeTutorial(raw, {
      repo: 'demo-tutorials',
      branch: 'main',
      slug: 'demo',
      target: 'hugo',
      rewriteImages: true,
    });
    expect(result.title).toBe('Hello');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].title).toBe('Step One');
    expect(result.steps[0].content).toContain('raw.githubusercontent.com/sap-tutorials/demo-tutorials/main/tutorials/demo');
    expect(result.steps[0].content).toContain('images/foo.png');
  });

  // TODO: enable after Task 2 adds rewriteImages support
  it.skip('passes images through unchanged when rewriteImages: false', () => {
    const raw = `---
title: Hello
description: x
parser: v2
---

### Step
![alt](./images/foo.png)
`;
    const result = composeTutorial(raw, {
      repo: 'r', branch: 'b', slug: 's', target: 'hugo', rewriteImages: false,
    });
    expect(result.steps[0].body).toContain('./images/foo.png');
    expect(result.steps[0].body).not.toContain('raw.githubusercontent.com');
  });
});
