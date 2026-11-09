// scripts/parsers/directives/diagram.ts
//
// Directive: `diagram` (leaf)
//
// diagram — ::diagram[file.svg]{alt caption src-dark theme}
//   SVG diagram embed with optional dark-mode variant. The label is the .svg
//   filename (required). Attrs: alt (required), caption, src-dark, theme (auto|none).
//   Renders to the `tut-diagram` Hugo shortcode.
//
// Registration:
//   registerDiagramDirective() — call once at pipeline init.

import { registerDirective, getRegistry } from '../directive-registry.js';
import { resolveSrc } from './resolve-src.js';
import { DirectiveParseError } from '../directives.js';
import type { DirectiveNode } from '../directives.js';

/**
 * Register the `diagram` (leaf) directive definition. Idempotent.
 */
export function registerDiagramDirective(): void {
  if (getRegistry().has('diagram')) return;
  registerDirective({
    name: 'diagram',
    kinds: ['leaf'],
    summary: 'SVG diagram embed with optional dark-mode variant. Renders a tut-diagram shortcode.',
    label: { required: true, markdown: false },
    attrs: {
      alt: { type: 'string', required: true },
      caption: { type: 'string', required: false },
      'src-dark': { type: 'string', required: false },
      theme: { type: 'enum', values: ['auto', 'none'], required: false, default: 'auto' },
    },
    render(node: unknown, renderCtx: unknown) {
      const n = node as DirectiveNode;
      const rc = renderCtx as Record<string, unknown>;

      // Validate alt is present (schema marks it required, but add an explicit
      // guard for the custom error code path in case called programmatically)
      if (!n.attrs.alt) {
        throw new DirectiveParseError(
          '::diagram requires an alt attribute',
          (rc?.slug as string | undefined) ?? '_',
          n.line ?? 0,
          n.column ?? 0,
          'diagram',
          'missing-attr',
        );
      }

      const repo = (rc?.repo as string | undefined) ?? '';
      const branch = (rc?.branch as string | undefined) ?? '';
      const slug = (rc?.slug as string | undefined) ?? '';

      const label = n.label ?? '';
      const src = resolveSrc(label, repo, branch, slug);

      const params: Record<string, string | number | boolean> = {
        src,
        alt: String(n.attrs.alt),
      };
      if (n.attrs.caption !== undefined) params.caption = String(n.attrs.caption);
      if (n.attrs['src-dark'] !== undefined) {
        params['src-dark'] = resolveSrc(String(n.attrs['src-dark']), repo, branch, slug);
      }
      if (n.attrs.theme !== undefined) params.theme = String(n.attrs.theme);
      return { params };
    },
    toText(node: unknown, _ctx: unknown) {
      const n = node as DirectiveNode;
      const alt = String(n.attrs.alt ?? '');
      return `[Diagram: ${alt}]`;
    },
    since: '1.0.0',
  });
}
