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

  it('passes images through unchanged when rewriteImages: false', () => {
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
    expect(result.steps[0].content).toContain('./images/foo.png');
    expect(result.steps[0].content).not.toContain('raw.githubusercontent.com');
  });

  // [#1931] Attachment-link resolver wired into compose
  it('rewrites relative attachment links to raw-GitHub URLs when rewriteImages: true', () => {
    const raw = `---
title: T
description: x
parser: v2
---

### Step One
See [doc](EX2.txt) below.
`;
    const result = composeTutorial(raw, {
      repo: 'abap-core-development', branch: 'main', slug: 'rap100',
      target: 'hugo', rewriteImages: true,
    });
    expect(result.body).toContain(
      'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100/EX2.txt'
    );
  });

  it('leaves attachment links untouched when rewriteImages: false', () => {
    const raw = `---
title: T
description: x
parser: v2
---

### Step One
See [doc](EX2.txt) below.
`;
    const result = composeTutorial(raw, {
      repo: 'abap-core-development', branch: 'main', slug: 'rap100',
      target: 'hugo', rewriteImages: false,
    });
    expect(result.body).toContain('[doc](EX2.txt)');
    expect(result.body).not.toContain('raw.githubusercontent.com');
  });
});
