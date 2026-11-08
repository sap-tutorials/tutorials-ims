// scripts/parsers/directives/reference-links.ts
//
// Smart reference link directives for tutorial markdown:
//   :tutorial-ref[slug]{label?} — cross-reference to another tutorial
//   :note-ref[n]                — SAP Note link
//   :help-ref[path]             — help.sap.com link with optional title cache
//   :api-ref[symbol]{lib}       — API reference link via curated library map
//   :since[label]               — version tag
//
// Exports: TUTORIAL_REF_DEF, NOTE_REF_DEF, HELP_REF_DEF, API_REF_DEF, SINCE_DEF
// (imported by Task 6's register-all.ts)
//
// Shortcode name convention: buildShortcode emits `{{< tut-<name> ... >}}`.
// So directive name "tutorial" → shortcode file "tut-tutorial.html".
//
// label auto-param: buildShortcode adds `label="<node.label>"` automatically when
// node.label is non-empty. Directives that need a computed display label mutate
// node.label in their expand hook; render() then omits `label` from output.params.

import type { DirectiveDef, DirectiveRenderOutput } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';
import type { DirectiveNode, ExpandDirectivesContext } from '../directives.js';
import apiLibsJson from './api-libs.json';

// api-libs.json is inlined at bundle time (static JSON import) so no sidecar
// file is needed next to the built parsers.bundle.mjs.
const API_LIBS: Record<string, string> = apiLibsJson as Record<string, string>;

// ─── :tutorial-ref[slug]{label?} ─────────────────────────────────────────────
//
// node.label = the raw slug (e.g. "hana-cloud-tutorial-1")
// expand: resolve catalog title, mutate node.label to display label, store slug in attrs
// render: emit { params: { slug, href } } — label comes from (mutated) node.label

export const TUTORIAL_REF_DEF: DirectiveDef = {
  name: 'tutorial',
  kinds: ['inline'],
  summary: 'Cross-reference to another tutorial by slug.',
  label: { required: true, markdown: false },
  attrs: {
    label: { type: 'string', required: false },
  },
  since: '1.0.0',

  expand(nodeUnknown: unknown, ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    const ctx = ctxUnknown as ExpandDirectivesContext;

    const slug = (node.label ?? '').toLowerCase();
    let resolvedLabel: string;

    if (ctx.catalogBySlug !== undefined) {
      // Catalog present — require the slug to exist
      const entry = ctx.catalogBySlug.get(slug);
      if (!entry) {
        throw new DirectiveParseError(
          `Tutorial slug "${slug}" not found in catalog`,
          ctx.slug,
          node.line,
          node.column,
          'tutorial',
          'invalid-attr',
        );
      }
      // Explicit label attr overrides catalog title
      resolvedLabel = typeof node.attrs['label'] === 'string' && node.attrs['label']
        ? node.attrs['label']
        : entry.title;
    } else {
      // No catalog — fail-open: use explicit label attr or fall back to slug
      resolvedLabel = typeof node.attrs['label'] === 'string' && node.attrs['label']
        ? node.attrs['label']
        : slug;
    }

    // Mutate node.label to the display label so buildShortcode picks it up as the
    // auto `label` param. Store the canonical slug in a private attr for render().
    node.label = resolvedLabel;
    node.attrs['_slug'] = slug;

    // Return empty string (falsy) so render() is still called by the framework
    return '';
  },

  render(nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    const node = nodeUnknown as DirectiveNode;
    // node.label was mutated to the display label by expand().
    // _slug carries the canonical lowercased slug.
    const slug = String(node.attrs['_slug'] ?? (node.label ?? '').toLowerCase());

    return {
      params: {
        slug,
        href: `/tutorials/${slug}`,
      },
      // No `label` key here — buildShortcode adds it automatically from node.label
    };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    // node.label was mutated to the display label by expand()
    return node.label ?? '';
  },
};

// ─── :note-ref[n] ────────────────────────────────────────────────────────────
//
// node.label = the note number (e.g. "2471802")
// expand: validate digits, mutate node.label to "SAP Note <n>", store n in attrs
// render: emit { params: { href } } — label comes from (mutated) node.label

const DIGITS_RE = /^\d+$/;

export const NOTE_REF_DEF: DirectiveDef = {
  name: 'note',
  kinds: ['inline'],
  summary: 'Link to an SAP Note by number.',
  label: { required: true, markdown: false },
  attrs: {},
  since: '1.0.0',

  expand(nodeUnknown: unknown, ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    const ctx = ctxUnknown as ExpandDirectivesContext;
    const n = node.label ?? '';

    if (!DIGITS_RE.test(n)) {
      throw new DirectiveParseError(
        `SAP Note number must be digits only, got "${n}"`,
        (ctx as unknown as { slug?: string }).slug ?? '_note',
        node.line,
        node.column,
        'note',
        'invalid-attr',
      );
    }

    node.attrs['_n'] = n;
    node.label = `SAP Note ${n}`;

    return '';
  },

  render(nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    const node = nodeUnknown as DirectiveNode;
    const n = String(node.attrs['_n'] ?? node.label ?? '');

    return {
      params: {
        href: `https://me.sap.com/notes/${n}`,
        // No `label` key — buildShortcode adds it from node.label ("SAP Note <n>")
      },
    };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    // node.label is the raw digit string when expand has NOT run (renderDirectivesAsText).
    // node.label is "SAP Note <n>" when expand HAS run (expandDirectives).
    // Normalise: if it's still the raw digit string, format it; otherwise return as-is.
    const n = node.label ?? '';
    return DIGITS_RE.test(n) ? `SAP Note ${n}` : n;
  },
};

// ─── :help-ref[path] ─────────────────────────────────────────────────────────
//
// node.label = the help topic path (e.g. "hana-cloud/SAP_HANA_Cloud_Guide")
// expand: look up title in helpTitleCache, mutate node.label to title or path
// render: emit { params: { href } } — label comes from (mutated) node.label

export const HELP_REF_DEF: DirectiveDef = {
  name: 'help',
  kinds: ['inline'],
  summary: 'Link to help.sap.com by topic path.',
  label: { required: true, markdown: false },
  attrs: {},
  since: '1.0.0',

  expand(nodeUnknown: unknown, ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    const ctx = ctxUnknown as ExpandDirectivesContext;
    const path = node.label ?? '';

    // Try title cache; fall back to path itself
    const title = ctx.helpTitleCache?.get(path) || path;
    node.attrs['_path'] = path;
    node.label = title;

    return '';
  },

  render(nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    const node = nodeUnknown as DirectiveNode;
    const path = String(node.attrs['_path'] ?? node.label ?? '');

    return {
      params: {
        href: `https://help.sap.com/docs/${path}`,
        // No `label` key — buildShortcode adds it from node.label (title or path)
      },
    };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    return node.label ?? '';
  },
};

// ─── :api-ref[symbol]{lib} ───────────────────────────────────────────────────
//
// node.label = the API symbol (e.g. "cds.ql.SELECT")
// render: validate lib, build href; emit { params: { symbol, lib, href } }
// node.label (symbol) auto-becomes `label` in shortcode — suppressed by clearing it
// tut-api.html uses `.Get "symbol"`, not `.Get "label"`

export const API_REF_DEF: DirectiveDef = {
  name: 'api',
  kinds: ['inline'],
  summary: 'Link to an API symbol in a curated library.',
  label: { required: true, markdown: false },
  attrs: {
    lib: { type: 'string', required: true },
  },
  since: '1.0.0',

  expand(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    // Store symbol before we clear node.label
    node.attrs['_symbol'] = node.label ?? '';
    // Clear node.label so buildShortcode does NOT auto-emit label="<symbol>".
    // tut-api.html uses `.Get "symbol"` exclusively.
    node.label = '';
    return '';
  },

  render(nodeUnknown: unknown, ctxUnknown: unknown): DirectiveRenderOutput {
    const node = nodeUnknown as DirectiveNode;
    const symbol = String(node.attrs['_symbol'] ?? '');
    const lib = String(node.attrs['lib'] ?? '');
    const ctx = ctxUnknown as { slug?: string };

    const urlTemplate = API_LIBS[lib];
    if (!urlTemplate) {
      throw new DirectiveParseError(
        `Unknown API library "${lib}" (known: ${Object.keys(API_LIBS).join(', ')})`,
        ctx.slug ?? '_api',
        node.line,
        node.column,
        'api',
        'invalid-attr',
      );
    }

    const href = urlTemplate.replace('{{symbol}}', symbol);

    return {
      params: {
        symbol,
        lib,
        href,
      },
    };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    // _symbol is set by expand(); fall back to node.label for renderDirectivesAsText
    // (which skips expand hooks)
    return String(node.attrs['_symbol'] ?? node.label ?? '');
  },
};

// ─── :since[label] ───────────────────────────────────────────────────────────
//
// node.label = the version string (e.g. "CAP 9")
// render: emit {} — label comes from node.label auto-param
// tut-since.html uses `.Get "label"`

export const SINCE_DEF: DirectiveDef = {
  name: 'since',
  kinds: ['inline'],
  summary: 'Version tag indicating when a feature was introduced.',
  label: { required: true, markdown: false },
  attrs: {},
  since: '1.0.0',

  render(nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    // node.label auto-becomes `label` param via buildShortcode
    return { params: {} };
  },

  toText(nodeUnknown: unknown, _ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    return node.label ?? '';
  },
};
