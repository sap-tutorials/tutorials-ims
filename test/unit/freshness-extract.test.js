import { describe, it, expect } from 'vitest';
import { extractCodeBlocks, extractTutorialContext } from '../../srv/lib/freshness-extract.js';

describe('extractCodeBlocks', () => {
  it('extracts fenced blocks with language, step ref, index, and adjacent prose', () => {
    const steps = [
      { number: 1, text: 'intro\n\n```Shell\nnpm init -y\n```\n' },
      { number: 2, text: 'code\n\n```JavaScript\nconst fetch = require("node-fetch");\n```\nand again\n\n```JavaScript\nconsole.log(1);\n```\n' },
    ];
    // NOTE: production reads persisted Steps rows; the parser accepts { number, content }.
    const blocks = extractCodeBlocks(steps.map(s => ({ number: s.number, content: s.text })));
    expect(blocks).toEqual([
      { stepRef: 1, codeBlockIndex: 0, lang: 'Shell', code: 'npm init -y', contextBefore: 'intro', contextAfter: '' },
      { stepRef: 2, codeBlockIndex: 0, lang: 'JavaScript', code: 'const fetch = require("node-fetch");', contextBefore: 'code', contextAfter: 'and again' },
      { stepRef: 2, codeBlockIndex: 1, lang: 'JavaScript', code: 'console.log(1);', contextBefore: 'and again', contextAfter: '' },
    ]);
  });

  it('captures the paragraph that explains an intentional error as contextAfter', () => {
    const md = 'Run the command:\n\n```bash\ncds watch\n```\n\nYou will see the error below on purpose — we fix it in the next step.\n';
    const [block] = extractCodeBlocks([{ number: 1, content: md }]);
    expect(block.contextBefore).toBe('Run the command:');
    expect(block.contextAfter).toBe('You will see the error below on purpose — we fix it in the next step.');
  });

  it('handles tilde fences and ignores unclosed fences gracefully', () => {
    const steps = [{ number: 1, content: '~~~py\nx=1\n~~~\n```\nunclosed' }];
    const blocks = extractCodeBlocks(steps);
    expect(blocks).toEqual([{ stepRef: 1, codeBlockIndex: 0, lang: 'py', code: 'x=1', contextBefore: '', contextAfter: '' }]);
  });

  it('returns [] for steps with no fences or empty input', () => {
    expect(extractCodeBlocks([{ number: 1, content: 'no code here' }])).toEqual([]);
    expect(extractCodeBlocks([])).toEqual([]);
  });
});

describe('extractTutorialContext', () => {
  it('pulls YAML frontmatter and the Prerequisites section', () => {
    const md = [
      '---',
      'title: Create a CAP service',
      'tags: [ cap, nodejs ]',
      '---',
      '',
      '# Create a CAP service',
      '',
      '## Prerequisites',
      '- A dev container in VS Code or GitHub Codespaces (provides a shell + Node.js)',
      '- An SAP BTP trial account',
      '',
      '## Step 1',
      'Do the thing.',
    ].join('\n');
    const ctx = extractTutorialContext(md);
    expect(ctx.frontmatter).toContain('title: Create a CAP service');
    expect(ctx.frontmatter).toContain('tags: [ cap, nodejs ]');
    expect(ctx.frontmatter).not.toContain('# Create a CAP service');
    expect(ctx.prerequisites).toContain('dev container in VS Code or GitHub Codespaces');
    expect(ctx.prerequisites).toContain('SAP BTP trial account');
    // Section extraction stops at the next same-level heading.
    expect(ctx.prerequisites).not.toContain('Do the thing.');
  });

  it('returns empty strings when frontmatter/prerequisites are absent', () => {
    const ctx = extractTutorialContext('# Title\n\nJust prose and\n\n```js\nx=1\n```\n');
    expect(ctx).toEqual({ frontmatter: '', prerequisites: '' });
  });

  it('is safe on empty / non-string input', () => {
    expect(extractTutorialContext('')).toEqual({ frontmatter: '', prerequisites: '' });
    expect(extractTutorialContext(null)).toEqual({ frontmatter: '', prerequisites: '' });
  });
});
