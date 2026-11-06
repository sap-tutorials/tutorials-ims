// scripts/parsers/directives/figure.ts
//
// Directive family: `figure` (container) and `image` (inline).
//
// figure — :::figure[Caption]{width align columns}
//   Container for one or more images with an auto-numbered caption.
//   Renders to the `tut-figure` Hugo shortcode.
//
// image — :image[alt]{src width height}
//   Inline sized image. src is resolved to a raw GitHub URL for relative paths.
//   Renders to the `tut-image` Hugo shortcode.
//
// Registration:
//   registerFigureDirectives(ctx?) — call once at pipeline init, or per-tutorial
//   when repo/branch/slug are known.  When ctx values are provided, the render
//   functions close over them; otherwise ctx values are read from the second arg
//   of render (via expandDirectives ctx.repo / ctx.branch / ctx.slug).

import { registerDirective } from '../directive-registry.js';
import { resolveSrc } from './resolve-src.js';
import type { DirectiveNode } from '../directives.js';

/** Optional context for closing over repo/branch/slug at registration time. */
export interface FigureDirectivesCtx {
  repo?: string;
  branch?: string;
  slug?: string;
}

/**
 * Register the `figure` (container) and `image` (inline) directive definitions.
 *
 * @param ctx - Optional context to close over at registration time.  When
 *   provided, `render` uses these values for URL resolution.  Any values not
 *   provided fall back to the `ctx` argument passed at render time
 *   (i.e., via `expandDirectives` second arg with `repo`/`branch`/`slug`).
 */
export function registerFigureDirectives(ctx: FigureDirectivesCtx = {}): void {
  const closedRepo = ctx.repo;
  const closedBranch = ctx.branch;
  const closedSlug = ctx.slug;

  // ── figure container ────────────────────────────────────────────────────────
  registerDirective({
    name: 'figure',
    kinds: ['container'],
    summary: 'Figure container with auto-numbered caption. Renders a tut-figure shortcode.',
    label: { required: true, markdown: true },
    attrs: {
      width: { type: 'string', required: false },
      align: { type: 'enum', values: ['left', 'center', 'right'], required: false },
      columns: { type: 'number', required: false },
    },
    render(node: unknown, renderCtx: unknown) {
      const n = node as DirectiveNode;
      const params: Record<string, string | number | boolean> = {};
      if (n.attrs.width !== undefined) params.width = String(n.attrs.width);
      if (n.attrs.align !== undefined) params.align = String(n.attrs.align);
      if (n.attrs.columns !== undefined) params.columns = Number(n.attrs.columns);
      return {
        params,
        body: n.body ?? '',
      };
    },
    toText(node: unknown, _ctx: unknown) {
      const n = node as DirectiveNode;
      const caption = n.label ?? '';
      const body = n.body ?? '';
      return `\nFigure: ${caption}\n${body}`;
    },
    since: '1.0.0',
  });

  // ── image inline ────────────────────────────────────────────────────────────
  registerDirective({
    name: 'image',
    kinds: ['inline'],
    summary: 'Inline sized image with resolved src URL. Renders a tut-image shortcode.',
    label: { required: true, markdown: false },
    attrs: {
      src: { type: 'string', required: true },
      width: { type: 'number', required: false },
      height: { type: 'number', required: false },
    },
    render(node: unknown, renderCtx: unknown) {
      const n = node as DirectiveNode;
      const rc = renderCtx as Record<string, unknown>;

      // Resolve repo/branch/slug: closure values take precedence, then ctx
      const repo = closedRepo ?? (rc?.repo as string | undefined) ?? '';
      const branch = closedBranch ?? (rc?.branch as string | undefined) ?? '';
      const slug = closedSlug ?? (rc?.slug as string | undefined) ?? '';

      const rawSrc = String(n.attrs.src ?? '');
      const resolvedSrc = resolveSrc(rawSrc, repo, branch, slug);

      const params: Record<string, string | number | boolean> = {
        src: resolvedSrc,
      };
      if (n.attrs.width !== undefined) params.width = Number(n.attrs.width);
      if (n.attrs.height !== undefined) params.height = Number(n.attrs.height);
      return { params };
    },
    toText(node: unknown, _ctx: unknown) {
      const n = node as DirectiveNode;
      const alt = n.label ?? '';
      return `![${alt}]`;
    },
    since: '1.0.0',
  });
}
