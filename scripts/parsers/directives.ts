// scripts/parsers/directives.ts
//
// CommonMark-style directive grammar (`:name[label]{attrs}`) for tutorial markdown.
//
// Directive syntax:
//   - Inline:    :name[label]{attrs}
//   - Leaf:      ::name[label]{attrs}        (alone on a line, 0–3 spaces indent)
//   - Container: :::name[label]{attrs}       (opening fence, followed by body, then :::)
//
// False-positive guards:
//   - Inline: preceded by line-start / whitespace / one of ([{"', followed by [
//   - :name{...} with no [ is NOT an inline directive
//   - :smile: (no [) is not a directive
//   - 10:30, std::vector, http:// are never matched (require whitespace/start before :)
//
// Masking:
//   - fenced code, indented code, HTML blocks, frontmatter → classifyLines, skip
//   - inline code spans (backtick runs) → tracked inline per line

import {
  classifyLines,
  isNonDelimiterLine,
} from './md-grammar.js';
import type { DirectiveDef } from './directive-registry.js';
import { getRegistry, registerDirective } from './directive-registry.js';
import { walkthroughDef } from './directives/tut-walkthrough.js';

// ─── Error class ────────────────────────────────────────────────────────────

export type DirectiveErrorCode =
  | 'unknown'
  | 'missing-attr'
  | 'invalid-attr'
  | 'duplicate-attr'
  | 'invalid-kind'
  | 'unclosed'
  | 'invalid-class'
  | 'invalid-content';

export class DirectiveParseError extends Error {
  slug: string;
  line: number;
  column: number;
  directive: string;
  code: DirectiveErrorCode;

  constructor(
    message: string,
    slug: string,
    line: number,
    column: number,
    directive: string,
    code: DirectiveErrorCode,
  ) {
    super(`${message} (${slug}:${line})`);
    this.name = 'DirectiveParseError';
    this.slug = slug;
    this.line = line;
    this.column = column;
    this.directive = directive;
    this.code = code;
  }
}

// ─── Node types ─────────────────────────────────────────────────────────────

export interface DirectiveNode {
  name: string;
  kind: 'inline' | 'leaf' | 'container';
  label?: string;
  attrs: Record<string, string | number | boolean>;
  id?: string;
  classes: string[];
  body?: string;
  line: number;
  column: number;
}

// ─── Warning type ───────────────────────────────────────────────────────────

export interface DirectiveWarning {
  code: string;
  line: number;
  message: string;
}

// ─── tokenizeAttrs ───────────────────────────────────────────────────────────

/**
 * Parse the content of a `{...}` attribute block into attrs, id, and classes.
 *
 * Syntax:
 *   key=value          → string attr
 *   key="quoted value" → string attr
 *   key=123            → number attr
 *   key                → boolean true
 *   #anchor            → id
 *   .classname         → class
 *
 * Throws DirectiveParseError with code 'duplicate-attr' on duplicate keys.
 */
export function tokenizeAttrs(
  raw: string,
  slug = '_tokenize',
  line = 0,
  directive = '',
): { attrs: Record<string, string | number | boolean>; id?: string; classes: string[] } {
  const attrs: Record<string, string | number | boolean> = {};
  const classes: string[] = [];
  let id: string | undefined;

  // Tokenise by splitting on whitespace while respecting quoted strings
  const tokens = splitAttrTokens(raw.trim());

  for (const token of tokens) {
    if (!token) continue;

    if (token.startsWith('#')) {
      id = token.slice(1);
      continue;
    }

    if (token.startsWith('.')) {
      classes.push(token.slice(1));
      continue;
    }

    const eqIdx = token.indexOf('=');
    if (eqIdx !== -1) {
      const key = token.slice(0, eqIdx);
      const rawVal = token.slice(eqIdx + 1);
      if (key in attrs) {
        throw new DirectiveParseError(
          `Duplicate attribute "${key}"`,
          slug,
          line,
          0,
          directive,
          'duplicate-attr',
        );
      }
      // Unquote if wrapped in double or single quotes; unescape \" and \'
      let val: string | number | boolean;
      if (
        (rawVal.startsWith('"') && rawVal.endsWith('"')) ||
        (rawVal.startsWith("'") && rawVal.endsWith("'"))
      ) {
        const inner = rawVal.slice(1, -1);
        val = inner.replace(/\\"/g, '"').replace(/\\'/g, "'");
      } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
        val = Number(rawVal);
      } else {
        val = rawVal;
      }
      attrs[key] = val;
    } else {
      // Bare word → boolean true flag
      if (token in attrs) {
        throw new DirectiveParseError(
          `Duplicate attribute "${token}"`,
          slug,
          line,
          0,
          directive,
          'duplicate-attr',
        );
      }
      attrs[token] = true;
    }
  }

  if (id !== undefined) {
    return { attrs, id, classes };
  }
  return { attrs, classes };
}

/** Split attr string into tokens respecting double- and single-quoted strings. */
function splitAttrTokens(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    // Skip whitespace
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;

    // Start of a token: could be quoted value after key=
    // We need to handle key="value with spaces" and key='value with spaces'
    let token = '';
    while (i < raw.length && !/\s/.test(raw[i])) {
      if (raw[i] === '"' || raw[i] === "'") {
        // Include from here until closing quote (inclusive), respecting backslash escapes
        const quoteChar = raw[i];
        const start = i;
        i++;
        while (i < raw.length) {
          if (raw[i] === '\\' && i + 1 < raw.length && raw[i + 1] === quoteChar) {
            // Backslash-escaped quote: skip both characters
            i += 2;
          } else if (raw[i] === quoteChar) {
            i++; // consume closing quote
            break;
          } else {
            i++;
          }
        }
        token += raw.slice(start, i);
      } else {
        token += raw[i];
        i++;
      }
    }
    if (token) tokens.push(token);
  }
  return tokens;
}

// ─── Inline code span masker ─────────────────────────────────────────────────

/**
 * Returns a version of the line with all inline code spans replaced by spaces,
 * preserving original character positions.
 */
function maskInlineCode(line: string): string {
  const chars = line.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '`') {
      // Count opening backtick run
      let runLen = 0;
      const start = i;
      while (i < chars.length && chars[i] === '`') {
        runLen++;
        i++;
      }
      // Find matching closing run
      let j = i;
      let found = false;
      while (j < chars.length) {
        if (chars[j] === '`') {
          let closeLen = 0;
          const closeStart = j;
          while (j < chars.length && chars[j] === '`') {
            closeLen++;
            j++;
          }
          if (closeLen === runLen) {
            // Mask from start to j
            for (let k = start; k < j; k++) chars[k] = ' ';
            found = true;
            break;
          }
        } else {
          j++;
        }
      }
      if (!found) {
        // No closing run — leave as-is, move past
        i = start + 1; // avoid infinite loop
      }
    } else {
      i++;
    }
  }
  return chars.join('');
}

// ─── Inline false-positive guard ─────────────────────────────────────────────

// Characters that may precede an inline directive's colon (besides line start)
const INLINE_PRECEDING_CHARS = new Set([' ', '\t', '(', '[', '{', '"', "'", ' ']);

/**
 * True when the character at position `pos-1` in `line` is a valid inline
 * directive prefix (line start, whitespace, or one of `([{"'`).
 */
function isValidInlinePrefix(line: string, pos: number): boolean {
  if (pos === 0) return true;
  return INLINE_PRECEDING_CHARS.has(line[pos - 1]);
}

// ─── Regex patterns ──────────────────────────────────────────────────────────

// A directive name: lowercase letter + lowercase letters/digits/hyphens
const NAME_PAT = '[a-z][a-z0-9-]*';

// Leaf/container fence: ::+ at line start (0–3 leading spaces, then colons)
const BLOCK_FENCE_RE = /^( {0,3})(:{2,})([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?(?:\{([^}]*)\})?[ \t]*$/;

// Inline: :name[label]{attrs}  — the [ is required
const INLINE_RE = new RegExp(`:(?:${NAME_PAT})\\[`, 'g');

// ─── Attr validation ─────────────────────────────────────────────────────────

function validateAttrs(
  raw: { attrs: Record<string, string | number | boolean>; id?: string; classes: string[] },
  def: DirectiveDef,
  kind: 'inline' | 'leaf' | 'container',
  slug: string,
  line: number,
  column: number,
  label: string | undefined,
): { attrs: Record<string, string | number | boolean>; id?: string; classes: string[] } {
  const name = def.name;

  // Validate kind
  if (!def.kinds.includes(kind)) {
    throw new DirectiveParseError(
      `Directive "${name}" does not support kind "${kind}" (allowed: ${def.kinds.join(', ')})`,
      slug,
      line,
      column,
      name,
      'invalid-kind',
    );
  }

  // Validate label requirement
  if (def.label?.required && (label === undefined || label === '')) {
    throw new DirectiveParseError(
      `Directive "${name}" requires a label`,
      slug,
      line,
      column,
      name,
      'missing-attr',
    );
  }

  // Validate classes
  if (def.classes && def.classes.length > 0) {
    for (const cls of raw.classes) {
      if (!def.classes.includes(cls)) {
        throw new DirectiveParseError(
          `Directive "${name}" does not allow class "${cls}" (allowed: ${def.classes.join(', ')})`,
          slug,
          line,
          column,
          name,
          'invalid-class',
        );
      }
    }
  } else if (raw.classes.length > 0) {
    // No classes defined but classes provided
    throw new DirectiveParseError(
      `Directive "${name}" does not allow any CSS classes`,
      slug,
      line,
      column,
      name,
      'invalid-class',
    );
  }

  // Validate required attrs
  for (const [attrName, attrDef] of Object.entries(def.attrs)) {
    if (attrDef.required && !(attrName in raw.attrs)) {
      throw new DirectiveParseError(
        `Directive "${name}" requires attribute "${attrName}"`,
        slug,
        line,
        column,
        name,
        'missing-attr',
      );
    }
  }

  // Validate attr types and unknown attrs
  for (const [attrName, attrVal] of Object.entries(raw.attrs)) {
    const attrDef = def.attrs[attrName];
    if (!attrDef) {
      // If the directive allows extra (free-form) attrs, skip unknown keys
      if (def.allowExtraAttrs) continue;
      throw new DirectiveParseError(
        `Directive "${name}" has no attribute "${attrName}"`,
        slug,
        line,
        column,
        name,
        'invalid-attr',
      );
    }

    // Coerce and validate type
    if (attrDef.type === 'number' && typeof attrVal !== 'number') {
      const n = Number(attrVal);
      if (isNaN(n)) {
        throw new DirectiveParseError(
          `Attribute "${attrName}" must be a number, got "${attrVal}"`,
          slug,
          line,
          column,
          name,
          'invalid-attr',
        );
      }
      raw.attrs[attrName] = n;
    } else if (attrDef.type === 'boolean' && typeof attrVal !== 'boolean') {
      if (attrVal !== 'true' && attrVal !== 'false') {
        throw new DirectiveParseError(
          `Attribute "${attrName}" must be a boolean, got "${attrVal}"`,
          slug,
          line,
          column,
          name,
          'invalid-attr',
        );
      }
      raw.attrs[attrName] = attrVal === 'true';
    } else if (attrDef.type === 'enum' && attrDef.values) {
      const strVal = String(attrVal);
      if (!attrDef.values.includes(strVal)) {
        throw new DirectiveParseError(
          `Attribute "${attrName}" must be one of [${attrDef.values.join(', ')}], got "${attrVal}"`,
          slug,
          line,
          column,
          name,
          'invalid-attr',
        );
      }
    } else if (attrDef.type === 'string' && attrDef.pattern) {
      const re = new RegExp(attrDef.pattern);
      if (!re.test(String(attrVal))) {
        throw new DirectiveParseError(
          `Attribute "${attrName}" does not match pattern ${attrDef.pattern}`,
          slug,
          line,
          column,
          name,
          'invalid-attr',
        );
      }
    }
  }

  return raw;
}

// ─── parseDirectives ─────────────────────────────────────────────────────────

/**
 * Parse all directives from `md`, using either the provided registry or the
 * global one.  Returns an array of parsed DirectiveNodes and any warnings.
 * Throws DirectiveParseError on schema violations.
 *
 * Unknown directive names produce a `directive/unknown` warning and are left
 * byte-for-byte unchanged (no node emitted).
 *
 * Directive syntax is never parsed inside:
 *   - fenced code blocks (kind === 'code')
 *   - indented code blocks (kind === 'code')
 *   - HTML blocks (kind === 'html')
 *   - frontmatter (blanked by classifyLines)
 *   - inline code spans (backtick runs)
 */
export function parseDirectives(
  md: string,
  opts: { slug: string; registry?: ReadonlyMap<string, DirectiveDef> },
): { nodes: DirectiveNode[]; warnings: DirectiveWarning[] } {
  const { slug } = opts;
  const registry = opts.registry ?? getRegistry();
  const lines = md.split('\n');
  const classes = classifyLines(md);
  const nodes: DirectiveNode[] = [];
  const warnings: DirectiveWarning[] = [];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const lineNum = i + 1; // 1-based

    // Block-classified lines: skip entirely
    if (isNonDelimiterLine(classes, i)) {
      i++;
      continue;
    }

    // Try block (leaf / container) match first
    const blockMatch = rawLine.match(BLOCK_FENCE_RE);
    if (blockMatch) {
      const [, , colons, name, label, rawAttrs] = blockMatch;
      const fenceLen = colons.length;
      const column = (blockMatch[1] ?? '').length; // leading spaces

      if (fenceLen === 2) {
        // Leaf directive
        const def = registry.get(name);
        if (!def) {
          warnings.push({
            code: 'directive/unknown',
            line: lineNum,
            message: `Unknown directive ":${name}" at ${slug}:${lineNum}`,
          });
          i++;
          continue;
        }
        const parsed = tokenizeAttrs(rawAttrs ?? '', slug, lineNum, name);
        const validated = validateAttrs(parsed, def, 'leaf', slug, lineNum, column, label);
        const node: DirectiveNode = {
          name,
          kind: 'leaf',
          attrs: validated.attrs,
          classes: validated.classes,
          line: lineNum,
          column,
        };
        if (label !== undefined) node.label = label;
        if (validated.id !== undefined) node.id = validated.id;
        nodes.push(node);
        i++;
        continue;
      } else if (fenceLen >= 3) {
        // Container directive — check registry FIRST (mirrors leaf branch).
        // An unknown name with no closing fence must NOT throw; leave the line
        // as literal text and emit a directive/unknown warning (byte-identity).
        const def = registry.get(name);
        if (!def) {
          warnings.push({
            code: 'directive/unknown',
            line: lineNum,
            message: `Unknown directive ":${name}" at ${slug}:${lineNum}`,
          });
          i++;
          continue;
        }

        // Registered container — now search for the closing fence (may throw).
        const closingFenceRe = new RegExp(`^[ ]{0,3}:{${fenceLen}}[ \\t]*$`);
        let bodyEnd = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].match(closingFenceRe)) {
            bodyEnd = j;
            break;
          }
        }
        if (bodyEnd === -1) {
          throw new DirectiveParseError(
            `Container directive ":::${name}" has no closing fence`,
            slug,
            lineNum,
            column,
            name,
            'unclosed',
          );
        }

        const parsed = tokenizeAttrs(rawAttrs ?? '', slug, lineNum, name);
        const validated = validateAttrs(parsed, def, 'container', slug, lineNum, column, label);

        // Body: raw lines between opening and closing fence (preserves nested directives as source)
        const bodyLines = lines.slice(i + 1, bodyEnd);
        const body = bodyLines.join('\n');

        const node: DirectiveNode = {
          name,
          kind: 'container',
          attrs: validated.attrs,
          classes: validated.classes,
          body,
          line: lineNum,
          column,
        };
        if (label !== undefined) node.label = label;
        if (validated.id !== undefined) node.id = validated.id;
        nodes.push(node);
        i = bodyEnd + 1;
        continue;
      }
    }

    // Inline directives: scan within this line
    // First mask inline code spans so directives inside backticks are not matched
    const maskedLine = maskInlineCode(rawLine);

    // Find all `:name[` occurrences in the masked line
    INLINE_RE.lastIndex = 0;
    let inlineMatch: RegExpExecArray | null;
    while ((inlineMatch = INLINE_RE.exec(maskedLine)) !== null) {
      const matchStart = inlineMatch.index;
      const matchedText = inlineMatch[0]; // e.g. ':echo['

      // False-positive guard: character before ':' must be line-start or allowed prefix
      if (!isValidInlinePrefix(maskedLine, matchStart)) continue;

      // Extract name
      const name = matchedText.slice(1, matchedText.length - 1); // strip leading ':' and trailing '['

      // Find matching ']' for label
      const labelStart = matchStart + matchedText.length;
      let labelEnd = -1;
      let depth = 1;
      for (let k = labelStart; k < maskedLine.length; k++) {
        if (maskedLine[k] === '[') depth++;
        else if (maskedLine[k] === ']') {
          depth--;
          if (depth === 0) {
            labelEnd = k;
            break;
          }
        }
      }
      if (labelEnd === -1) continue; // no closing ]

      const label = rawLine.slice(labelStart, labelEnd);

      // Check for optional {attrs}
      let rawAttrs = '';
      let afterDirective = labelEnd + 1;
      if (afterDirective < maskedLine.length && maskedLine[afterDirective] === '{') {
        let braceDepth = 1;
        const attrStart = afterDirective + 1;
        let attrEnd = -1;
        for (let k = attrStart; k < maskedLine.length; k++) {
          if (maskedLine[k] === '{') braceDepth++;
          else if (maskedLine[k] === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              attrEnd = k;
              break;
            }
          }
        }
        if (attrEnd !== -1) {
          rawAttrs = rawLine.slice(attrStart, attrEnd);
          afterDirective = attrEnd + 1;
        }
      }

      const column = matchStart;

      const def = registry.get(name);
      if (!def) {
        warnings.push({
          code: 'directive/unknown',
          line: lineNum,
          message: `Unknown directive ":${name}" at ${slug}:${lineNum}`,
        });
        continue;
      }

      const parsed = tokenizeAttrs(rawAttrs, slug, lineNum, name);
      const validated = validateAttrs(parsed, def, 'inline', slug, lineNum, column, label);

      const node: DirectiveNode = {
        name,
        kind: 'inline',
        label,
        attrs: validated.attrs,
        classes: validated.classes,
        line: lineNum,
        column,
      };
      if (validated.id !== undefined) node.id = validated.id;
      nodes.push(node);
    }

    i++;
  }

  return { nodes, warnings };
}

// ─── escapeShortcodeParam ────────────────────────────────────────────────────

/**
 * HTML-escape a string for safe use as a shortcode parameter value.
 *
 * Escapes: & < > " \
 * Order matters: & is escaped first so the entities produced by later
 * replacements are not double-escaped.  Backslash is escaped last (as &#92;,
 * which is now safe because all prior `&` have already become `&amp;`) to
 * prevent a trailing backslash from being read as escaping the closing `"` in
 * Hugo shortcode params, e.g. `param="foo\"` would otherwise let the `"` be
 * interpreted as escaped.
 *
 * Example:
 *   escapeShortcodeParam('foo" bar')  → 'foo&quot; bar'
 *   escapeShortcodeParam('a & b')     → 'a &amp; b'
 *   escapeShortcodeParam('foo\\')     → 'foo&#92;'
 *   escapeShortcodeParam('foo\\"')    → 'foo&#92;&quot;'
 */
export function escapeShortcodeParam(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\\/g, '&#92;')
    // Hugo's shortcode arg lexer cannot handle a raw newline inside a quoted
    // param value — it reports "unterminated quoted string". Encode CR/LF as
    // numeric entities so any multi-line value (e.g. the walkthrough directive's
    // fenced `code` param) survives as a single quoted arg. The consuming
    // shortcode template must decode &#10;/&#13; back before markdownify.
    .replace(/\r/g, '&#13;')
    .replace(/\n/g, '&#10;');
}

// ─── expandDirectives ────────────────────────────────────────────────────────

export interface ExpandDirectivesContext {
  slug: string;
  variables?: Array<{ name: string }>;
  registry?: ReadonlyMap<string, DirectiveDef>;
  channel?: string;
  repo?: string;
  branch?: string;
  /**
   * Slim catalog index keyed by tutorial slug. Used by `:ref` and similar
   * directives to resolve titles and metadata without loading the full nav JSON.
   */
  catalogBySlug?: Map<string, { title: string; time: number; level?: string }>;
  /**
   * Snippet source map: snippetKey → raw markdown source.
   * Populated by the fetch pipeline before `expandDirectives` is called.
   * Consumed by the `:include` directive (Task 2).
   */
  snippetMap?: Map<string, string>;
  /**
   * Ancestor snippet names for cycle detection in nested `:include` directives.
   * Each frame pushes the current snippet name before recursing and pops on return.
   * An empty/absent array means we are at the top-level (tutorial body).
   */
  includeChain?: string[];
  /**
   * Cache for `:help` directive title lookups. Keyed by help topic ID.
   * Populated lazily by the `:help` directive renderer (Task 3).
   */
  helpTitleCache?: Map<string, string>;
  /**
   * Maps snippetKey → { repo, branch } for resolving image URLs inside snippet
   * content to the snippet's own raw GitHub base URL (not the including tutorial's).
   * When absent, repo/branch are parsed from the snippetKey itself.
   */
  snippetRepoMap?: Map<string, { repo: string; branch: string }>;
}

/**
 * Parse and render all directives in `body`, returning the expanded markdown.
 *
 * Algorithm:
 *   1. Parse directives from body
 *   2. Run expand hooks (with cycle/depth guard) to transform nodes in-place
 *   3. Render each node to its Hugo shortcode equivalent
 *   4. Replace nodes back-to-front by line+column to preserve positions
 *   5. Return the expanded markdown
 *
 * Directives whose render function returns plain markdown (not a shortcode)
 * are emitted unwrapped.
 */
export function expandDirectives(body: string, ctx: ExpandDirectivesContext): string {
  const registry = ctx.registry ?? getRegistry();
  const { nodes } = parseDirectives(body, { slug: ctx.slug, registry });

  if (nodes.length === 0) {
    return body;
  }

  const lines = body.split('\n');

  // Track which node instances have been expanded to detect cycles
  const expandedNodes = new WeakSet<DirectiveNode>();
  // Store expand results for non-container nodes (leaf/inline) so the render
  // phase can use the expansion instead of calling render().
  const expandResults = new WeakMap<DirectiveNode, string>();
  const MAX_EXPAND_DEPTH = 10;

  /**
   * Recursively expand a node's expand hook output, re-parsing any directives
   * it contains and expanding those as well. Depth limit prevents infinite cycles.
   * Threads the same visitedNodes set and depth counter through the recursion.
   */
  function runExpandRecursive(node: DirectiveNode, depth: number = 0): string | undefined {
    if (depth >= MAX_EXPAND_DEPTH) {
      throw new Error(
        `Directive expand cycle detected: max depth ${MAX_EXPAND_DEPTH} exceeded at ${ctx.slug}:${node.line}`,
      );
    }

    if (expandedNodes.has(node)) {
      throw new Error(
        `Directive expand cycle detected: node at ${ctx.slug}:${node.line} re-emits itself`,
      );
    }

    const def = registry.get(node.name);
    if (!def || !def.expand) {
      return undefined;
    }

    expandedNodes.add(node);

    const expanded = def.expand(node, ctx);
    if (!expanded) {
      return undefined;
    }

    // If the expanded output contains directives, recursively expand them
    const { nodes: newNodes } = parseDirectives(expanded, { slug: ctx.slug, registry });

    // Process each nested directive through the same expansion context
    let result = expanded;
    for (const newNode of newNodes) {
      const newExpanded = runExpandRecursive(newNode, depth + 1);
      if (newExpanded !== undefined) {
        // Replace newNode's source span with its expanded text
        // Find the node's source span in result and replace it
        // This is the directive source pattern: :name[label]{attrs} or ::name or :::name
        let searchStart = 0;
        const pattern = `:${newNode.name}\\[`;
        const match = result.substring(searchStart).match(new RegExp(pattern));
        if (match) {
          const matchPos = searchStart + match.index!;
          // Find the end of the directive
          let i = matchPos + pattern.length - 1; // after :name[
          let bracketDepth = 1;
          i++;
          while (i < result.length && bracketDepth > 0) {
            if (result[i] === '[') bracketDepth++;
            else if (result[i] === ']') bracketDepth--;
            i++;
          }
          // Check for {attrs}
          if (i < result.length && result[i] === '{') {
            let braceDepth = 1;
            i++;
            while (i < result.length && braceDepth > 0) {
              if (result[i] === '{') braceDepth++;
              else if (result[i] === '}') braceDepth--;
              i++;
            }
          }
          // Replace [matchPos, i) with newExpanded
          result = result.slice(0, matchPos) + newExpanded + result.slice(i);
        }
      }
    }

    return result;
  }

  // Expand all nodes (in place)
  for (const node of nodes) {
    const expanded = runExpandRecursive(node);
    if (expanded) {
      if (node.kind === 'container') {
        // For containers, update the body
        node.body = expanded;
      } else {
        // For leaf/inline nodes with an expand hook, store the result for
        // use in the render phase (bypasses render() call).
        expandResults.set(node, expanded);
      }
    }
  }

  // Render each node and prepare replacements
  // Sort nodes back-to-front: by line (descending), then by column (descending)
  const sortedNodes = [...nodes].sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    return (b.column || 0) - (a.column || 0);
  });

  /**
   * Build a Hugo shortcode from a directive node's render output.
   * The framework handles escaping of all parameter values and labels.
   */
  function buildShortcode(
    node: DirectiveNode,
    output: any, // DirectiveRenderOutput
  ): string {
    // If output declares markdown, return it unwrapped
    if (output.markdown !== undefined) {
      return output.markdown;
    }

    // Build params from output.params, escaping each value
    const params: string[] = [];
    const emitted = new Set<string>();

    // Add label as first param if present
    if (node.label) {
      params.push(`label="${escapeShortcodeParam(node.label)}"`);
      emitted.add('label');
    }

    // Add remaining params from output.params, skipping any key already
    // emitted above. Newer directives (ui/menu/kbd/icon/ask) also return
    // `label` in output.params; without this guard it is emitted twice,
    // producing `label="x" label="x"` in the shortcode.
    if (output.params) {
      for (const [k, v] of Object.entries(output.params)) {
        if (emitted.has(k)) continue;
        params.push(`${k}="${escapeShortcodeParam(String(v))}"`);
        emitted.add(k);
      }
    }

    const paramStr = params.length > 0 ? ' ' + params.join(' ') : '';

    if (node.kind === 'container') {
      // For containers, build opening + body + closing
      const body = output.body || '';
      return `{{% tut-${node.name}${paramStr} %}}\n${body}\n{{% /tut-${node.name} %}}`;
    } else {
      // For inline/leaf
      return `{{< tut-${node.name}${paramStr} >}}`;
    }
  }

  // Process nodes back-to-front, replacing as we go
  for (const node of sortedNodes) {
    const def = registry.get(node.name);
    if (!def) continue;

    // For leaf/inline nodes whose expand hook produced content, use that
    // directly as the replacement (bypasses render() — expand already produced
    // the final markdown, e.g. for ::include which inlines snippet source).
    const expandedContent = expandResults.get(node);

    const output = def.render(node, { slug: ctx.slug, variables: ctx.variables, channel: ctx.channel, repo: ctx.repo, branch: ctx.branch });
    const rendered = expandedContent !== undefined ? expandedContent : buildShortcode(node, output);
    const lineIdx = node.line - 1; // 0-based

    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    if (node.kind === 'leaf') {
      // Replace the entire leaf line
      lines[lineIdx] = rendered;
    } else if (node.kind === 'container') {
      // Find the closing fence - need to track fence length
      // The fence length is determined by how many colons in the opening line
      const openingLine = lines[lineIdx];
      const fenceMatch = openingLine.match(/^( {0,3})(:{2,})/);
      const fenceLen = fenceMatch ? fenceMatch[2].length : 3;

      let closeLineIdx = lineIdx + 1;
      const closingFenceRe = new RegExp(`^[ ]{0,3}:${'{' + fenceLen + '}'}[ \\t]*$`);
      while (closeLineIdx < lines.length) {
        if (lines[closeLineIdx].match(closingFenceRe)) {
          break;
        }
        closeLineIdx++;
      }

      if (closeLineIdx >= lines.length) closeLineIdx = lines.length - 1;

      // Replace lines from lineIdx to closeLineIdx with the rendered output
      const newLines = rendered.split('\n');
      lines.splice(lineIdx, closeLineIdx - lineIdx + 1, ...newLines);
    } else if (node.kind === 'inline') {
      // Find and replace the inline directive on this line
      const line = lines[lineIdx];

      // Build the pattern: :name[label]{attrs}
      // Start search from node.column
      const namePrefix = `:${node.name}[`;
      let atStart = -1;

      // Find the start position by scanning from the expected column
      for (let i = Math.max(0, (node.column || 0) - 5); i < line.length; i++) {
        if (line.substring(i).startsWith(namePrefix)) {
          atStart = i;
          break;
        }
      }

      if (atStart === -1) continue;

      // Find the end of this directive (closing brace or end of inline construct)
      let i = atStart + namePrefix.length - 1; // position after :name[

      // Skip label - find closing ]
      let bracketDepth = 1;
      i++;
      while (i < line.length && bracketDepth > 0) {
        if (line[i] === '[') bracketDepth++;
        else if (line[i] === ']') bracketDepth--;
        i++;
      }

      // Now check for {attrs}
      if (i < line.length && line[i] === '{') {
        let braceDepth = 1;
        i++;
        while (i < line.length && braceDepth > 0) {
          if (line[i] === '{') braceDepth++;
          else if (line[i] === '}') braceDepth--;
          i++;
        }
      }

      const atEnd = i;

      // Replace the span [atStart, atEnd) with rendered
      lines[lineIdx] = line.slice(0, atStart) + rendered + line.slice(atEnd);
    }
  }

  return lines.join('\n');
}

// ─── renderDirectivesAsText ──────────────────────────────────────────────────

/**
 * Parse all directives in `markdown` and replace each REGISTERED directive
 * with its `def.toText(node, ctx)` output.  Unknown directives are left
 * verbatim (byte-for-byte unchanged).  Directive-looking text inside code
 * fences / indented code / inline code spans is never touched — parseDirectives
 * already skips those contexts so no nodes are produced for them.
 *
 * Replacements are applied back-to-front by source offset (matching the
 * expandDirectives pattern) so earlier positions remain valid after splicing.
 *
 * @param markdown - Raw tutorial markdown (may include fences, frontmatter, etc.)
 * @param opts     - Optional: `registry` override (defaults to global registry).
 * @returns Plain text / plain markdown with directive syntax removed.
 */
export function renderDirectivesAsText(
  markdown: string,
  opts?: { registry?: ReadonlyMap<string, DirectiveDef> },
): string {
  const registry = opts?.registry ?? getRegistry();
  const { nodes } = parseDirectives(markdown, { slug: 'text', registry });

  if (nodes.length === 0) {
    return markdown;
  }

  const lines = markdown.split('\n');

  // Sort nodes back-to-front: descending line, then descending column
  const sortedNodes = [...nodes].sort((a, b) => {
    if (b.line !== a.line) return b.line - a.line;
    return (b.column || 0) - (a.column || 0);
  });

  for (const node of sortedNodes) {
    const def = registry.get(node.name);
    if (!def) continue; // unknown → leave verbatim

    const text = def.toText(node, { slug: 'text' });
    const lineIdx = node.line - 1; // 0-based

    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    if (node.kind === 'leaf') {
      lines[lineIdx] = text;
    } else if (node.kind === 'container') {
      // Find the closing fence to know how many lines to splice out
      const openingLine = lines[lineIdx];
      const fenceMatch = openingLine.match(/^( {0,3})(:{2,})/);
      const fenceLen = fenceMatch ? fenceMatch[2].length : 3;

      let closeLineIdx = lineIdx + 1;
      const closingFenceRe = new RegExp(`^[ ]{0,3}:${'{' + fenceLen + '}'}[ \\t]*$`);
      while (closeLineIdx < lines.length) {
        if (lines[closeLineIdx].match(closingFenceRe)) {
          break;
        }
        closeLineIdx++;
      }
      if (closeLineIdx >= lines.length) closeLineIdx = lines.length - 1;

      const textLines = text.split('\n');
      lines.splice(lineIdx, closeLineIdx - lineIdx + 1, ...textLines);
    } else if (node.kind === 'inline') {
      const line = lines[lineIdx];
      const namePrefix = `:${node.name}[`;
      let atStart = -1;

      for (let i = Math.max(0, (node.column || 0) - 5); i < line.length; i++) {
        if (line.substring(i).startsWith(namePrefix)) {
          atStart = i;
          break;
        }
      }
      if (atStart === -1) continue;

      // Find end of inline directive: skip label [ ... ]
      let i = atStart + namePrefix.length - 1;
      let bracketDepth = 1;
      i++;
      while (i < line.length && bracketDepth > 0) {
        if (line[i] === '[') bracketDepth++;
        else if (line[i] === ']') bracketDepth--;
        i++;
      }

      // Skip optional {attrs}
      if (i < line.length && line[i] === '{') {
        let braceDepth = 1;
        i++;
        while (i < line.length && braceDepth > 0) {
          if (line[i] === '{') braceDepth++;
          else if (line[i] === '}') braceDepth--;
          i++;
        }
      }

      lines[lineIdx] = line.slice(0, atStart) + text + line.slice(i);
    }
  }

  return lines.join('\n');
}

// [task5] Register walkthrough container directive
registerDirective(walkthroughDef);
