import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decide, extractCommand } = require('../../../.github/hooks/block-full-test-suite.cjs');

const denied = (cmd: string) => decide(cmd).permissionDecision === 'deny';

describe('copilot block-full-test-suite hook', () => {
  it.each([
    'npm test',
    'npm run test',
    'npm run test:all',
    'npm run test:a11y',
    'npm run test:watch',
    'npx vitest run',
    'npx vitest run --project unit',
    'cd x; npm test',
    'scripts/quiet-run.ps1 npm test',
    '& .\\scripts\\quiet-run.ps1 npm test',
  ])('denies full suite: %s', (cmd) => {
    expect(denied(cmd)).toBe(true);
  });

  it.each([
    'npm test -- test/unit/foo.test.js',
    'npx vitest run test/unit/foo.test.js',
    'npx vitest run --project unit test/unit/foo.test.js',
    'npx vitest run -t "some name"',
    'npm run test:smoke',
    'npm run test:e2e',
    'npm run test:hybrid',
    'git status',
  ])('allows: %s', (cmd) => {
    expect(denied(cmd)).toBe(false);
  });

  it('reads Copilot (toolArgs string) and Claude (tool_input) payloads', () => {
    expect(extractCommand({ toolName: 'powershell', toolArgs: JSON.stringify({ command: 'npm test' }) })).toBe('npm test');
    expect(extractCommand({ tool_name: 'Bash', tool_input: { command: 'npm test' } })).toBe('npm test');
  });

  it('ignores non-shell tools', () => {
    expect(extractCommand({ toolName: 'view', toolArgs: { command: 'npm test' } })).toBe('');
  });
});
