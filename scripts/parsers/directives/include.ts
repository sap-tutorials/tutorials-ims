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

  // 3. Suffix match: any key ending with /_snippets/<label>
  const suffix = '/_snippets/' + label;
  for (const key of snippetMap.keys()) {
    if (key.endsWith(suffix)) return key;
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

    // Recursively expand nested ::include directives within the snippet,
    // passing the updated chain so nested cycles are detected.
    const updatedCtx: ExpandDirectivesContext = {
      ...ctx,
      includeChain: [...chain, snippetKey],
    };

    return expandDirectives(substituted, updatedCtx);
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
