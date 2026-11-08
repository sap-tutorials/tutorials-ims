// scripts/parsers/directives/include.ts
//
// ::include[snippetKey]{param1=val1} directive.
//
// Inlines a shared snippet (markdown fragment) into the tutorial body at the
// point where the directive appears.  Supports:
//   - Param substitution: {{param:x}} → node.attrs.x
//   - Cycle detection: semantic chain via ctx.includeChain
//   - Max include depth: 3 (MAX_INCLUDE_DEPTH)
//   - Step-heading rejection: snippets must not contain `### ` headings
//   - Shared-namespace shorthand: `shared:name` → `shared/name`
//
// Export: INCLUDE_DEF (imported by Task 6's register-all.ts)

import type { DirectiveDef, DirectiveRenderOutput } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';
import type { DirectiveNode, ExpandDirectivesContext } from '../directives.js';
import { expandDirectives } from '../directives.js';
import { RAW_BASE_URL } from '../types.js';

/** Maximum nesting depth for ::include chains (A→B→C is depth 3; A→B→C→D is rejected). */
const MAX_INCLUDE_DEPTH = 3;

/**
 * Derive the snippet key from the directive label.
 *
 * Resolution order (first hit wins):
 *   1. `shared:<name>` → `shared/<name>`  (shared-namespace shorthand)
 *   2. Exact label as key                  (for tests with direct keys)
 *   3. Key ending with `/_snippets/<label>` (production repo-prefix form)
 *
 * Returns the resolved key and the raw normalized label (for chain tracking).
 */
function resolveSnippetKey(
  label: string,
  snippetMap: Map<string, string>,
): string | undefined {
  // 1. shared: prefix normalisation
  if (label.startsWith('shared:')) {
    const normalized = 'shared/' + label.slice(7);
    if (snippetMap.has(normalized)) return normalized;
    return normalized; // return the normalized form even if not found (for error messages)
  }

  // 2. Exact label match
  if (snippetMap.has(label)) return label;

  // 3. Suffix match: any key ending with /_snippets/<label>. Per-repo snippet
  //    keys retain the `.md` extension (github.ts keeps it so `::include[step.md]`
  //    matches exactly), but authors write the label WITHOUT the extension
  //    (docs/authors/content-reuse-and-references.md). So try the bare suffix
  //    first, then the `.md` form, so `::include[btp-trial-setup]` resolves the
  //    stored `…/_snippets/btp-trial-setup.md` key.
  const suffixes = label.endsWith('.md')
    ? ['/_snippets/' + label]
    : ['/_snippets/' + label, '/_snippets/' + label + '.md'];
  for (const suffix of suffixes) {
    for (const key of snippetMap.keys()) {
      if (key.endsWith(suffix)) return key;
    }
  }

  // Fallback: return the label so the caller can produce a clear error message
  return label;
}

/**
 * Strip YAML frontmatter (--- ... ---) from a markdown string.
 * Returns the body after the frontmatter block, or the full string if none.
 */
function stripFrontmatter(src: string): string {
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
  return src.replace(fm, '');
}

/**
 * Substitute all `{{param:x}}` occurrences with the value of `node.attrs[x]`.
 * Unresolved params are replaced with an empty string.
 */
function substituteParams(
  body: string,
  attrs: Record<string, string | number | boolean>,
): string {
  return body.replace(/\{\{param:([^}]+)\}\}/g, (_, key) => {
    const val = attrs[key];
    if (val === undefined || val === null) return '';
    return String(val);
  });
}

/**
 * Derive repo and branch from a snippet key.
 *
 * Key forms:
 *   - `shared/<name>`             → repo = `tutorial-snippets`, branch = `main`
 *   - `<repo>/_snippets/<name>`   → repo = `<repo>`, branch = `main`
 *
 * Returns null if the key doesn't match a known form.
 */
function repoFromSnippetKey(
  snippetKey: string,
  snippetRepoMap?: Map<string, { repo: string; branch: string }>,
): { repo: string; branch: string } | null {
  // Check explicit map first
  if (snippetRepoMap?.has(snippetKey)) {
    return snippetRepoMap.get(snippetKey)!;
  }

  // shared/<name>
  if (snippetKey.startsWith('shared/')) {
    return { repo: 'tutorial-snippets', branch: 'main' };
  }

  // <repo>/_snippets/<name>
  const snippetSegIdx = snippetKey.indexOf('/_snippets/');
  if (snippetSegIdx > 0) {
    const repo = snippetKey.slice(0, snippetSegIdx);
    return { repo, branch: 'main' };
  }

  return null;
}

/**
 * Rewrite relative image URLs inside snippet markdown to absolute GitHub raw URLs.
 *
 * Only rewrites `![alt](relative-path)` where the path does NOT start with
 * `http://`, `https://`, or `../`. Absolute and parent-relative URLs are left unchanged.
 */
function rewriteSnippetImages(
  body: string,
  snippetKey: string,
  snippetRepoMap?: Map<string, { repo: string; branch: string }>,
): string {
  const origin = repoFromSnippetKey(snippetKey, snippetRepoMap);
  if (!origin) return body;

  const base = `${RAW_BASE_URL}/sap-tutorials/${origin.repo}/${origin.branch}/_snippets/`;

  return body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, src) => {
    // Leave absolute URLs and parent-relative paths untouched
    if (src.startsWith('http://') || src.startsWith('https://') || src.startsWith('../')) {
      return `![${alt}](${src})`;
    }
    return `![${alt}](${base}${src})`;
  });
}

export const INCLUDE_DEF: DirectiveDef = {
  name: 'include',
  kinds: ['leaf'],
  summary: 'Inline a shared snippet (markdown fragment) at this location.',
  label: { required: true, markdown: false },
  attrs: {}, // declared attrs are empty; free-form params are accepted via allowExtraAttrs
  allowExtraAttrs: true,
  since: '1.0.0',

  expand(nodeUnknown: unknown, ctxUnknown: unknown): string {
    const node = nodeUnknown as DirectiveNode;
    const ctx = ctxUnknown as ExpandDirectivesContext;

    const label = node.label ?? '';
    const snippetMap = ctx.snippetMap ?? new Map<string, string>();
    const chain = ctx.includeChain ?? [];

    // Derive the canonical snippet key
    const snippetKey = resolveSnippetKey(label, snippetMap) ?? label;

    // Cycle detection: semantic chain check
    if (chain.includes(snippetKey)) {
      throw new DirectiveParseError(
        `directive/include-cycle: ${[...chain, snippetKey].join(' → ')}`,
        ctx.slug,
        node.line,
        node.column,
        'include',
        'unknown',
      );
    }

    // Depth limit: chain.length is the current depth (0 = top-level call)
    // If chain.length >= MAX_INCLUDE_DEPTH, the next push would reach depth MAX_INCLUDE_DEPTH+1
    if (chain.length >= MAX_INCLUDE_DEPTH) {
      throw new DirectiveParseError(
        `directive/include-depth: max include depth ${MAX_INCLUDE_DEPTH} exceeded (chain: ${[...chain, snippetKey].join(' → ')})`,
        ctx.slug,
        node.line,
        node.column,
        'include',
        'unknown',
      );
    }

    // Look up snippet body
    const rawSource = snippetMap.get(snippetKey);
    if (rawSource === undefined) {
      throw new DirectiveParseError(
        `directive/include-not-found: ${snippetKey}`,
        ctx.slug,
        node.line,
        node.column,
        'include',
        'missing-attr',
      );
    }

    // Strip frontmatter
    const body = stripFrontmatter(rawSource);

    // Reject snippets containing step headings (### )
    if (/^### /m.test(body)) {
      throw new DirectiveParseError(
        'directive/include-step-heading',
        ctx.slug,
        node.line,
        node.column,
        'include',
        'invalid-attr',
      );
    }

    // Param substitution
    const substituted = substituteParams(body, node.attrs);

    // Rewrite relative image URLs in snippet content to absolute GitHub raw URLs,
    // so images render correctly regardless of which tutorial includes the snippet.
    const withImages = rewriteSnippetImages(substituted, snippetKey, ctx.snippetRepoMap);

    // Recursively expand nested ::include directives within the snippet,
    // passing the updated chain so nested cycles are detected.
    const updatedCtx: ExpandDirectivesContext = {
      ...ctx,
      includeChain: [...chain, snippetKey],
    };

    // Augment any parse error thrown inside the snippet body with context
    // so authors see: "<original message> (included from <slug>:<line> via <key>)"
    // instead of a bare line number relative to the snippet file.
    // Avoid double-wrapping: if the message already contains "included from",
    // re-throw as-is (the inner frame already annotated it).
    try {
      return expandDirectives(withImages, updatedCtx);
    } catch (err: unknown) {
      if (err instanceof Error && !err.message.includes('included from')) {
        err.message = `${err.message} (included from ${ctx.slug}:${node.line} via ${snippetKey})`;
      }
      throw err;
    }
  },

  render(_nodeUnknown: unknown, _ctxUnknown: unknown): DirectiveRenderOutput {
    // expand() runs before render() and fully rewrites the source.
    // render() should never be called in practice for ::include — return
    // an empty markdown string for registry compliance.
    return { markdown: '' };
  },

  toText(_nodeUnknown: unknown, _ctxUnknown: unknown): string {
    // The expanded content is already plain text from the snippet itself.
    return '';
  },
};
