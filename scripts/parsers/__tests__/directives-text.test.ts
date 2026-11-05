import { describe, it, expect, beforeEach } from 'vitest';
import { renderDirectivesAsText } from '../directives.js';
import {
  registerDirective,
  resetRegistry,
  type DirectiveDef,
  type DirectiveRenderOutput,
} from '../directive-registry.js';

// Fixture: details container — renders `**<label>**\n\n<body>` in text mode
const DETAILS_DEF: DirectiveDef = {
  name: 'details',
  kinds: ['container'],
  summary: 'Collapsible details section',
  label: { required: true, markdown: false },
  attrs: {},
  classes: [],
  render: (node: any): DirectiveRenderOutput => ({
    params: { label: node.label },
    body: node.body,
  }),
  toText: (node: any): string => `**${node.label}**\n\n${node.body}`,
  since: '1.0.0',
};

// Fixture: kbd inline — renders the key combo text
const KBD_DEF: DirectiveDef = {
  name: 'kbd',
  kinds: ['inline'],
  summary: 'Keyboard shortcut',
  label: { required: true, markdown: false },
  attrs: {},
  classes: [],
  render: (node: any): DirectiveRenderOutput => ({
    params: { keys: node.label },
  }),
  toText: (node: any): string => node.label,
  since: '1.0.0',
};

describe('renderDirectivesAsText', () => {
  beforeEach(() => {
    resetRegistry();
    registerDirective(DETAILS_DEF);
    registerDirective(KBD_DEF);
  });

  it('replaces a details container with bold label + body', () => {
    const md = ':::details[Why]\ncontent\n:::';
    const result = renderDirectivesAsText(md);
    expect(result).toBe('**Why**\n\ncontent');
    expect(result).not.toContain(':::');
  });

  it('replaces a kbd inline with the key combo text', () => {
    const md = 'Press :kbd[Mod+S] to save.';
    const result = renderDirectivesAsText(md);
    expect(result).toBe('Press Mod+S to save.');
    expect(result).not.toContain(':kbd[');
  });

  it('leaves unknown directives verbatim', () => {
    const md = 'Hello :foo[x] world';
    const result = renderDirectivesAsText(md);
    expect(result).toBe('Hello :foo[x] world');
  });

  it('does not alter directives inside a code fence', () => {
    const md = '```\n:::details[Why]\ncontent\n:::\n```';
    const result = renderDirectivesAsText(md);
    expect(result).toBe('```\n:::details[Why]\ncontent\n:::\n```');
  });

  // MCP/AI read-path contract (Task 6): a step body containing :::details and
  // :kbd[ must come back with readable text and NO raw directive syntax so
  // models/clients see plain prose.
  it('MCP read-path: step body with :::details[Why] and :kbd[Mod+S] yields readable text, no ::: or :kbd[', () => {
    const stepBody = [
      '### Save the file',
      '',
      ':::details[Why]',
      'Saving writes your changes to disk.',
      ':::',
      '',
      'Press :kbd[Mod+S] to save.',
    ].join('\n');

    const result = renderDirectivesAsText(stepBody);

    // No raw directive syntax remains
    expect(result).not.toContain(':::');
    expect(result).not.toContain(':kbd[');

    // Readable equivalents present
    expect(result).toContain('**Why**');
    expect(result).toContain('Mod+S');
    expect(result).toContain('Press');
  });

  // Identity contract: directive-free content must pass through unchanged.
  it('is a no-op for directive-free markdown', () => {
    const md = '### Install CAP\n\nRun `npm install -g @sap/cds-dk` to install.\n';
    expect(renderDirectivesAsText(md)).toBe(md);
  });
});
