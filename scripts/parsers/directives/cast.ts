// scripts/parsers/directives/cast.ts
//
// Directive: `cast` (leaf)
//
// cast — ::cast[file.cast]{rows cols speed poster idle-limit}
//   Embeds an asciinema terminal recording. The label is the .cast filename
//   (required). Attrs: rows, cols, speed (default 1), poster, idle-limit.
//   Renders to the `tut-cast` Hugo shortcode which lazy-loads the asciinema player.
//
// Registration:
//   registerCastDirective() — call once at pipeline init.

import { registerDirective } from '../directive-registry.js';
import { resolveSrc } from './resolve-src.js';
import type { DirectiveNode } from '../directives.js';

/**
 * Register the `cast` (leaf) directive definition.
 */
export function registerCastDirective(): void {
  registerDirective({
    name: 'cast',
    kinds: ['leaf'],
    summary: 'Asciinema terminal recording embed (lazy-loaded). Renders a tut-cast shortcode.',
    label: { required: true, markdown: false },
    attrs: {
      rows: { type: 'number', required: false },
      cols: { type: 'number', required: false },
      speed: { type: 'number', required: false, default: 1 },
      poster: { type: 'string', required: false },
      'idle-limit': { type: 'number', required: false },
    },
    render(node: unknown, renderCtx: unknown) {
      const n = node as DirectiveNode;
      const rc = renderCtx as Record<string, unknown>;

      const repo = (rc?.repo as string | undefined) ?? '';
      const branch = (rc?.branch as string | undefined) ?? '';
      const slug = (rc?.slug as string | undefined) ?? '';

      const label = n.label ?? '';
      const src = resolveSrc(label, repo, branch, slug);

      const params: Record<string, string | number | boolean> = { src };
      if (n.attrs.rows !== undefined) params.rows = Number(n.attrs.rows);
      if (n.attrs.cols !== undefined) params.cols = Number(n.attrs.cols);
      if (n.attrs.speed !== undefined) params.speed = Number(n.attrs.speed);
      if (n.attrs.poster !== undefined) params.poster = String(n.attrs.poster);
      if (n.attrs['idle-limit'] !== undefined) params['idle-limit'] = Number(n.attrs['idle-limit']);
      return { params };
    },
    toText(node: unknown, _ctx: unknown) {
      const n = node as DirectiveNode;
      const label = n.label ?? '';
      return `[terminal recording: ${label}]`;
    },
    since: '1.0.0',
  });
}
