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
import { getRegistry } from './directive-registry.js';

// ─── Error class ────────────────────────────────────────────────────────────

export type DirectiveErrorCode =
  | 'unknown'
  | 'missing-attr'
  | 'invalid-attr'
  | 'duplicate-attr'
  | 'invalid-kind'
  | 'unclosed'
  | 'invalid-class';

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
      // Unquote if wrapped in double quotes
      let val: string | number | boolean;
      if (rawVal.startsWith('"') && rawVal.endsWith('"')) {
        val = rawVal.slice(1, -1);
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

/** Split attr string into tokens respecting double-quoted strings. */
function splitAttrTokens(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    // Skip whitespace
    while (i < raw.length && /\s/.test(raw[i])) i++;
    if (i >= raw.length) break;

    // Start of a token: could be quoted value after key=
    // We need to handle key="value with spaces"
    let token = '';
    while (i < raw.length && !/\s/.test(raw[i])) {
      if (raw[i] === '"') {
        // Include from here until closing quote (inclusive)
        const start = i;
        i++;
        while (i < raw.length && raw[i] !== '"') i++;
        if (i < raw.length) i++; // consume closing quote
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
        const validated = validateAttrs(parsed, def, 'leaf', slug, lineNum, column);
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
        // Container directive — find matching closing fence
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

        const def = registry.get(name);
        if (!def) {
          warnings.push({
            code: 'directive/unknown',
            line: lineNum,
            message: `Unknown directive ":${name}" at ${slug}:${lineNum}`,
          });
          // Still skip over the container body
          i = bodyEnd + 1;
          continue;
        }

        const parsed = tokenizeAttrs(rawAttrs ?? '', slug, lineNum, name);
        const validated = validateAttrs(parsed, def, 'container', slug, lineNum, column);

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
      const validated = validateAttrs(parsed, def, 'inline', slug, lineNum, column);

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
