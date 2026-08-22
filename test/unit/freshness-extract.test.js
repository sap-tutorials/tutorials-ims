import { describe, it, expect } from 'vitest';
import { extractCodeBlocks } from '../../srv/lib/freshness-extract.js';

describe('extractCodeBlocks', () => {
  it('extracts fenced blocks with language, step ref, and per-step index', () => {
    const steps = [
      { number: 1, text: 'intro\n\n```Shell\nnpm init -y\n```\n' },
      { number: 2, text: 'code\n\n```JavaScript\nconst fetch = require("node-fetch");\n```\nand again\n\n```JavaScript\nconsole.log(1);\n```\n' },
    ];
    // NOTE: production reads persisted Steps rows; the parser accepts { number, content }.
    const blocks = extractCodeBlocks(steps.map(s => ({ number: s.number, content: s.text })));
    expect(blocks).toEqual([
      { stepRef: 1, codeBlockIndex: 0, lang: 'Shell', code: 'npm init -y' },
      { stepRef: 2, codeBlockIndex: 0, lang: 'JavaScript', code: 'const fetch = require("node-fetch");' },
      { stepRef: 2, codeBlockIndex: 1, lang: 'JavaScript', code: 'console.log(1);' },
    ]);
  });

  it('handles tilde fences and ignores unclosed fences gracefully', () => {
    const steps = [{ number: 1, content: '~~~py\nx=1\n~~~\n```\nunclosed' }];
    const blocks = extractCodeBlocks(steps);
    expect(blocks).toEqual([{ stepRef: 1, codeBlockIndex: 0, lang: 'py', code: 'x=1' }]);
  });

  it('returns [] for steps with no fences or empty input', () => {
    expect(extractCodeBlocks([{ number: 1, content: 'no code here' }])).toEqual([]);
    expect(extractCodeBlocks([])).toEqual([]);
  });
});
