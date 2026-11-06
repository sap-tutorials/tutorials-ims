// scripts/parsers/directives/prerequisites.ts
//
// ::requires[slug]{optional?} directive.
//
// Renders a prerequisite card for a single tutorial slug.
// Multiple prerequisites are expressed by repeating the directive.
//
// Syntax:
//   ::requires[hana-cloud-tutorial-1]
//   ::requires[hana-cloud-tutorial-2]{optional}
//
// Export: REQUIRES_DEF (imported by Task 6's register-all.ts)

import type { DirectiveDef, DirectiveRenderOutput } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';
import type { DirectiveNode, ExpandDirectivesContext } from '../directives.js';

export const REQUIRES_DEF: DirectiveDef = {
  name: 'requires',
  kinds: ['leaf'],
  summary: 'Render a prerequisite card linking to another tutorial.',
  label: { required: true, markdown: false },
  attrs: {
    optional: { type: 'boolean', required: false, default: false },
  },
  since: '1.0.0',

  expand(nodeUnknown: unknown, ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    const ctx = ctxUnknown as ExpandDirectivesContext;

    const slug = (node.label ?? '').toLowerCase();

    if (ctx.catalogBySlug !== undefined) {
      const entry = ctx.catalogBySlug.get(slug);
      if (!entry) {
        throw new DirectiveParseError(
          `::requires: unknown tutorial slug "${slug}"`,
          ctx.slug,
          node.line,
          node.column,
          'requires',
          'invalid-attr',
        );
      }
      // Store resolved metadata in attrs for render()
      node.attrs['_title'] = entry.title;
      node.attrs['_time'] = entry.time ?? 0;
    } else {
      // No catalog — fail-open: use slug as title
      node.attrs['_title'] = slug;
      node.attrs['_time'] = 0;
    }

    // Normalize slug on node.label so render() reads it consistently
    node.attrs['_slug'] = slug;

    // Return empty string (falsy) so render() is still called by the framework
    return '';
  },

  render(nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    const node = nodeUnknown as DirectiveNode;

    const slug = String(node.attrs['_slug'] ?? (node.label ?? '').toLowerCase());
    const title = String(node.attrs['_title'] ?? slug);
    const time = String(node.attrs['_time'] ?? 0);
    const optional =
      node.attrs['optional'] === true ||
      node.attrs['optional'] === 'true' ||
      node.attrs['optional'] === '';

    return {
      params: {
        slug,
        title,
        time,
        optional: optional ? 'true' : 'false',
      },
    };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    // _title is set by expand(); fall back to slug (node.label) for renderDirectivesAsText
    // (which skips expand hooks)
    return String(node.attrs['_title'] ?? node.label ?? '');
  },
};
