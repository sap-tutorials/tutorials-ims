import { describe, it, expect, beforeEach } from 'vitest';
import { parseDirectives, DirectiveParseError } from '../directives.js';
import { resetRegistry, getRegistry } from '../directive-registry.js';
import { registerUiDirectives } from '../directives/ui.js';
import { generateIconAllowlist } from '../../generate-icon-allowlist.js';

describe('UI directives — registration and parsing', () => {
  beforeEach(() => {
    resetRegistry();
    registerUiDirectives();
  });

  // ─── :menu ─────────────────────────────────────────────────────────────────

  describe(':menu', () => {
    it('parses A > B > C label, name=menu', () => {
      const { nodes } = parseDirectives(':menu[A > B > C]', { slug: 'test' });
      expect(nodes).toHaveLength(1);
      expect(nodes[0].name).toBe('menu');
      expect(nodes[0].label).toBe('A > B > C');
    });

    it('toText produces bold joined with → separator', () => {
      const { nodes } = parseDirectives(':menu[A > B > C]', { slug: 'test' });
      const def = getRegistry().get('menu')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('**A → B → C**');
    });

    it('parses A → B (arrow separator) and toText echoes it', () => {
      const { nodes } = parseDirectives(':menu[A → B]', { slug: 'test' });
      expect(nodes[0].label).toBe('A → B');
      const def = getRegistry().get('menu')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('**A → B**');
    });
  });

  // ─── :kbd ──────────────────────────────────────────────────────────────────

  describe(':kbd', () => {
    it('parses Mod+S and render() resolves win/mac/linux', () => {
      const { nodes } = parseDirectives(':kbd[Mod+S]', { slug: 'test' });
      expect(nodes).toHaveLength(1);
      const def = getRegistry().get('kbd')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.win).toBe('Ctrl+S');
      expect(out.params.mac).toBe('⌘S');
      expect(out.params.linux).toBe('Ctrl+S');
    });

    it('toText returns the raw label', () => {
      const { nodes } = parseDirectives(':kbd[Mod+S]', { slug: 'test' });
      const def = getRegistry().get('kbd')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('Mod+S');
    });

    it('Mod+Shift+P renders win=Ctrl+Shift+P mac=⌘⇧P', () => {
      const { nodes } = parseDirectives(':kbd[Mod+Shift+P]', { slug: 'test' });
      const def = getRegistry().get('kbd')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.win).toBe('Ctrl+Shift+P');
      expect(out.params.mac).toBe('⌘⇧P');
    });

    it('explicit mac override is passed verbatim, win is computed', () => {
      const { nodes } = parseDirectives(':kbd[Mod+T]{mac="Ctrl+Option+T"}', { slug: 'test' });
      const def = getRegistry().get('kbd')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.mac).toBe('Ctrl+Option+T');
      expect(out.params.win).toBe('Ctrl+T');
    });

    it('unknown key token throws DirectiveParseError code=invalid-attr with token name', () => {
      // parse succeeds (unknown key is not caught at parse time, only at render)
      const { nodes } = parseDirectives(':kbd[Mod+Foo]', { slug: 'test' });
      const def = getRegistry().get('kbd')!;
      expect(() => def.render(nodes[0], { slug: 'test' })).toThrow(DirectiveParseError);
      try {
        def.render(nodes[0], { slug: 'test' });
      } catch (e) {
        expect((e as DirectiveParseError).code).toBe('invalid-attr');
        expect((e as Error).message).toContain('Foo');
      }
    });
  });

  // ─── :icon ─────────────────────────────────────────────────────────────────

  describe(':icon', () => {
    it('parses :icon[add], render has name=add label=Add', () => {
      const { nodes } = parseDirectives(':icon[add]', { slug: 'test' });
      expect(nodes).toHaveLength(1);
      const def = getRegistry().get('icon')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.name).toBe('add');
      expect(out.params.label).toBe('Add');
    });

    it('toText returns [add icon] when no label attr', () => {
      const { nodes } = parseDirectives(':icon[add]', { slug: 'test' });
      const def = getRegistry().get('icon')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('[add icon]');
    });

    it('explicit label attr overrides title-case default', () => {
      const { nodes } = parseDirectives(':icon[add]{label="Create"}', { slug: 'test' });
      const def = getRegistry().get('icon')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.label).toBe('Create');
    });

    it('toText returns label attr when present', () => {
      const { nodes } = parseDirectives(':icon[add]{label="Create"}', { slug: 'test' });
      const def = getRegistry().get('icon')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('Create');
    });

    it('unknown icon name throws DirectiveParseError code=invalid-attr with suggestion', () => {
      // plusss → suggestion should be 'add' or 'sys-add' or 'plus' (closest by Levenshtein)
      const { nodes } = parseDirectives(':icon[plusss]', { slug: 'test' });
      const def = getRegistry().get('icon')!;
      expect(() => def.render(nodes[0], { slug: 'test' })).toThrow(DirectiveParseError);
      try {
        def.render(nodes[0], { slug: 'test' });
      } catch (e) {
        expect((e as DirectiveParseError).code).toBe('invalid-attr');
        // Should mention a suggestion
        const msg = (e as Error).message.toLowerCase();
        expect(msg).toMatch(/add|plus/);
      }
    });
  });

  // ─── :ui ───────────────────────────────────────────────────────────────────

  describe(':ui', () => {
    it('parses :ui[Save], render has label=Save type=""', () => {
      const { nodes } = parseDirectives(':ui[Save]', { slug: 'test' });
      expect(nodes).toHaveLength(1);
      const def = getRegistry().get('ui')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.label).toBe('Save');
      expect(out.params.type).toBe('');
    });

    it('toText returns **Save**', () => {
      const { nodes } = parseDirectives(':ui[Save]', { slug: 'test' });
      const def = getRegistry().get('ui')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('**Save**');
    });

    it(':ui[Save]{type=button} has type=button in render', () => {
      const { nodes } = parseDirectives(':ui[Save]{type=button}', { slug: 'test' });
      const def = getRegistry().get('ui')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.type).toBe('button');
    });

    it(':ui[X]{type=tooltip} throws invalid-attr (not in enum)', () => {
      expect(() => parseDirectives(':ui[X]{type=tooltip}', { slug: 'test' })).toThrow(DirectiveParseError);
      try {
        parseDirectives(':ui[X]{type=tooltip}', { slug: 'test' });
      } catch (e) {
        expect((e as DirectiveParseError).code).toBe('invalid-attr');
      }
    });
  });

  // ─── :ask ──────────────────────────────────────────────────────────────────

  describe(':ask', () => {
    it('parses :ask[Explain CDS projections], render has prompt=...', () => {
      const { nodes } = parseDirectives(':ask[Explain CDS projections]', { slug: 'test' });
      expect(nodes).toHaveLength(1);
      const def = getRegistry().get('ask')!;
      const out = def.render(nodes[0], { slug: 'test' }) as { params: Record<string, string> };
      expect(out.params.prompt).toBe('Explain CDS projections');
    });

    it('toText returns Ask Joule: "..."', () => {
      const { nodes } = parseDirectives(':ask[Explain CDS projections]', { slug: 'test' });
      const def = getRegistry().get('ask')!;
      expect(def.toText(nodes[0], { slug: 'test' })).toBe('Ask Joule: "Explain CDS projections"');
    });

    it('label > 300 chars throws DirectiveParseError code=invalid-attr mentioning "300"', () => {
      const longLabel = 'x'.repeat(301);
      const { nodes } = parseDirectives(`:ask[${longLabel}]`, { slug: 'test' });
      const def = getRegistry().get('ask')!;
      expect(() => def.render(nodes[0], { slug: 'test' })).toThrow(DirectiveParseError);
      try {
        def.render(nodes[0], { slug: 'test' });
      } catch (e) {
        expect((e as DirectiveParseError).code).toBe('invalid-attr');
        expect((e as Error).message).toContain('300');
      }
    });
  });
});

// ─── Icon allowlist generator ─────────────────────────────────────────────────

describe('generateIconAllowlist', () => {
  // Use an environment variable if set; fall back to the main project's node_modules
  // (works in both the worktree and the main checkout, using the Windows-native path).
  const DIST_PATH =
    process.env.UI5_ICONS_DIST ??
    'D:\\projects\\tutorials-poc\\node_modules\\@ui5\\webcomponents-icons\\dist';

  it('returns a non-empty array of strings', () => {
    const result = generateIconAllowlist(DIST_PATH);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(typeof result[0]).toBe('string');
  });

  it('includes "add" and "accept"', () => {
    const result = generateIconAllowlist(DIST_PATH);
    expect(result).toContain('add');
    expect(result).toContain('accept');
  });

  it('does not include "index" or asset bundle names', () => {
    const result = generateIconAllowlist(DIST_PATH);
    expect(result).not.toContain('index');
    expect(result).not.toContain('AllIcons');
    expect(result).not.toContain('Assets');
  });

  it('is sorted alphabetically', () => {
    const result = generateIconAllowlist(DIST_PATH);
    const sorted = [...result].sort();
    expect(result).toEqual(sorted);
  });
});
