// scripts/parsers/directives/compare.ts
//
// Directive: `compare` (leaf)
//
// compare — ::compare{before after labels?}
//   Before/after image comparison slider. `before` and `after` are resolved to
//   full URLs via resolveSrc. `labels` is an optional pipe-separated label pair
//   (e.g. "Old|New"). Renders to the `tut-compare` Hugo shortcode.
//
// Registration:
//   registerCompareDirective() — call once at pipeline init.

import { registerDirective } from '../directive-registry.js';
import { resolveSrc } from './resolve-src.js';
import type { DirectiveNode } from '../directives.js';

/**
 * Register the `compare` (leaf) directive definition.
 */
export function registerCompareDirective(): void {
  registerDirective({
    name: 'compare',
    kinds: ['leaf'],
    summary: 'Before/after image comparison slider. Renders a tut-compare shortcode.',
    attrs: {
      before: { type: 'string', required: true },
      after: { type: 'string', required: true },
      labels: { type: 'string', required: false },
    },
    render(node: unknown, renderCtx: unknown) {
      const n = node as DirectiveNode;
      const rc = renderCtx as Record<string, unknown>;

      const repo = (rc?.repo as string | undefined) ?? '';
      const branch = (rc?.branch as string | undefined) ?? '';
      const slug = (rc?.slug as string | undefined) ?? '';

      const rawBefore = String(n.attrs.before ?? '');
      const rawAfter = String(n.attrs.after ?? '');

      const resolvedBefore = resolveSrc(rawBefore, repo, branch, slug);
      const resolvedAfter = resolveSrc(rawAfter, repo, branch, slug);

      const params: Record<string, string | number | boolean> = {
        before: resolvedBefore,
        after: resolvedAfter,
      };
      if (n.attrs.labels !== undefined) {
        params.labels = String(n.attrs.labels);
      }
      return { params };
    },
    toText(node: unknown, _ctx: unknown) {
      const n = node as DirectiveNode;
      const before = String(n.attrs.before ?? '');
      const after = String(n.attrs.after ?? '');
      return `(Before: ${before}) (After: ${after})`;
    },
    since: '1.0.0',
  });
}
