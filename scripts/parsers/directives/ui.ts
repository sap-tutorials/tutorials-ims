// scripts/parsers/directives/ui.ts
//
// Registers five UI-interaction directives:
//   :menu   — navigation menu path
//   :kbd    — keyboard shortcut (per-OS formatting)
//   :icon   — UI5 icon reference
//   :ui     — generic UI element label
//   :ask    — Ask Joule prompt
//
// Side-effect: call registerUiDirectives() once at startup.
// In tests: resetRegistry(); registerUiDirectives()

import { registerDirective } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';
import type { DirectiveNode } from '../directives.js';
import iconAllowlist from './icon-allowlist.json' assert { type: 'json' };

// ─── Key token constants ──────────────────────────────────────────────────────

/** All recognized key token names (case-sensitive). */
const KNOWN_KEYS = new Set([
  // Modifier aliases
  'Mod', 'Ctrl', 'Alt', 'Shift', 'Meta', 'Win', 'Super',
  // Special keys
  'Enter', 'Return', 'Tab', 'Space', 'Backspace', 'Delete', 'Escape', 'Esc',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  // Single printable characters (a-z, 0-9, punctuation)
  // These are validated below via the single-char check
]);

/** Single printable characters that are valid key tokens. */
function isSinglePrintableChar(token: string): boolean {
  // Single character: a letter, digit, or common punctuation
  if (token.length !== 1) return false;
  return /^[a-zA-Z0-9`~!@#$%^&*()_\-+=\[\]{};:'",.<>?/\\|]$/.test(token);
}

/** Validate a token and throw DirectiveParseError if unknown. */
function validateKeyToken(
  token: string,
  slug: string,
  line: number,
  column: number,
): void {
  if (KNOWN_KEYS.has(token)) return;
  if (isSinglePrintableChar(token)) return;
  throw new DirectiveParseError(
    `Unknown key token "${token}" in :kbd directive`,
    slug,
    line,
    column,
    'kbd',
    'invalid-attr',
  );
}

/**
 * Split a keyboard combo string (e.g. "Mod+Shift+P") into tokens.
 * Throws DirectiveParseError on unknown tokens.
 */
function parseKeyTokens(
  combo: string,
  slug: string,
  line: number,
  column: number,
): string[] {
  const tokens = combo.split('+').map(t => t.trim());
  for (const token of tokens) {
    validateKeyToken(token, slug, line, column);
  }
  return tokens;
}

/** Mac substitution map for modifier keys. */
const MAC_MAP: Record<string, string> = {
  Mod: '⌘',
  Alt: '⌥',
  Shift: '⇧',
  Ctrl: '⌃',
  Enter: '↩',
  Return: '↩',
};

/** Win/Linux substitution map for modifier keys. */
const WIN_MAP: Record<string, string> = {
  Mod: 'Ctrl',
};

/**
 * Format an array of key tokens for a target OS.
 * Mac: substitute symbols, join WITHOUT separator.
 * Win/Linux: substitute Mod→Ctrl, join with '+'.
 */
function formatKeys(tokens: string[], os: 'win' | 'mac' | 'linux'): string {
  if (os === 'mac') {
    const mapped = tokens.map(t => MAC_MAP[t] ?? t);
    return mapped.join('');
  }
  // win / linux
  const mapped = tokens.map(t => WIN_MAP[t] ?? t);
  return mapped.join('+');
}

// ─── Icon validation helpers ──────────────────────────────────────────────────

const ICON_SET = new Set<string>(iconAllowlist as string[]);

/** Compute Levenshtein distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use two-row DP to save memory
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,       // insert
        prev[j] + 1,           // delete
        prev[j - 1] + cost,    // replace
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Find top-2 closest icon names by Levenshtein distance.
 * Returns them as a comma-separated suggestion string.
 */
function findIconSuggestions(name: string): string {
  const list = iconAllowlist as string[];
  const scored = list.map(icon => ({ icon, dist: levenshtein(name, icon) }));
  scored.sort((a, b) => a.dist - b.dist);
  return scored
    .slice(0, 2)
    .map(s => `"${s.icon}"`)
    .join(', ');
}

// ─── Title-case helper ────────────────────────────────────────────────────────

/**
 * Convert a kebab-case or lowercase icon name to Title Case.
 * "add" → "Add", "action-settings" → "Action Settings"
 */
function titleCase(name: string): string {
  return name
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// ─── Registration ─────────────────────────────────────────────────────────────

/** Register all five UI directives into the global registry. */
export function registerUiDirectives(): void {

  // ── :menu ──────────────────────────────────────────────────────────────────
  registerDirective({
    name: 'menu',
    kinds: ['inline'],
    summary: 'Navigation menu path (e.g. File > New > Project)',
    label: { required: true, markdown: false },
    attrs: {},
    since: '1.0.0',
    render(node: unknown) {
      const n = node as DirectiveNode;
      return { params: { label: n.label! } };
    },
    toText(node: unknown) {
      const n = node as DirectiveNode;
      const label = n.label ?? '';
      // Replace ' > ' with ' → ' for text output
      const formatted = label.replace(/ > /g, ' → ');
      return `**${formatted}**`;
    },
  });

  // ── :kbd ───────────────────────────────────────────────────────────────────
  registerDirective({
    name: 'kbd',
    kinds: ['inline'],
    summary: 'Keyboard shortcut with per-OS formatting',
    label: { required: true, markdown: false },
    attrs: {
      win:   { type: 'string' },
      mac:   { type: 'string' },
      linux: { type: 'string' },
    },
    since: '1.0.0',
    render(node: unknown, ctx: unknown) {
      const n = node as DirectiveNode;
      const slug = (ctx as { slug: string }).slug ?? '_kbd';
      const label = n.label!;
      const line = n.line ?? 0;
      const column = n.column ?? 0;

      // Parse and validate key tokens (throws on unknown token)
      const tokens = parseKeyTokens(label, slug, line, column);

      // Resolve per-OS values: explicit override takes priority
      const winVal  = typeof n.attrs.win   === 'string' ? n.attrs.win   : formatKeys(tokens, 'win');
      const macVal  = typeof n.attrs.mac   === 'string' ? n.attrs.mac   : formatKeys(tokens, 'mac');
      const linuxVal = typeof n.attrs.linux === 'string' ? n.attrs.linux : formatKeys(tokens, 'linux');

      return {
        params: {
          label,
          win:   winVal,
          mac:   macVal,
          linux: linuxVal,
        },
      };
    },
    toText(node: unknown) {
      const n = node as DirectiveNode;
      return n.label ?? '';
    },
  });

  // ── :icon ──────────────────────────────────────────────────────────────────
  registerDirective({
    name: 'icon',
    kinds: ['inline'],
    summary: 'UI5 icon reference by name',
    label: { required: true, markdown: false },
    attrs: {
      label: { type: 'string' },
    },
    since: '1.0.0',
    render(node: unknown, ctx: unknown) {
      const n = node as DirectiveNode;
      const slug = (ctx as { slug: string }).slug ?? '_icon';
      const iconName = n.label!;
      const line = n.line ?? 0;
      const column = n.column ?? 0;

      // Validate icon name against allowlist
      if (!ICON_SET.has(iconName)) {
        const suggestions = findIconSuggestions(iconName);
        throw new DirectiveParseError(
          `Unknown icon "${iconName}". Did you mean: ${suggestions}?`,
          slug,
          line,
          column,
          'icon',
          'invalid-attr',
        );
      }

      const labelAttr = typeof n.attrs.label === 'string' ? n.attrs.label : undefined;
      return {
        params: {
          name:  iconName,
          label: labelAttr ?? titleCase(iconName),
        },
      };
    },
    toText(node: unknown) {
      const n = node as DirectiveNode;
      const labelAttr = typeof n.attrs.label === 'string' ? n.attrs.label : undefined;
      return labelAttr ?? `[${n.label} icon]`;
    },
  });

  // ── :ui ────────────────────────────────────────────────────────────────────
  registerDirective({
    name: 'ui',
    kinds: ['inline'],
    summary: 'Generic UI element label (button, field, tab, link)',
    label: { required: true, markdown: false },
    attrs: {
      type: {
        type: 'enum',
        values: ['button', 'field', 'tab', 'link'],
      },
    },
    since: '1.0.0',
    render(node: unknown) {
      const n = node as DirectiveNode;
      const typeVal = typeof n.attrs.type === 'string' ? n.attrs.type : '';
      return {
        params: {
          label: n.label!,
          type:  typeVal,
        },
      };
    },
    toText(node: unknown) {
      const n = node as DirectiveNode;
      return `**${n.label}**`;
    },
  });

  // ── :ask ───────────────────────────────────────────────────────────────────
  registerDirective({
    name: 'ask',
    kinds: ['inline'],
    summary: 'Ask Joule AI assistant a question',
    label: { required: true, markdown: false },
    attrs: {},
    since: '1.0.0',
    render(node: unknown, ctx: unknown) {
      const n = node as DirectiveNode;
      const slug = (ctx as { slug: string }).slug ?? '_ask';
      const prompt = n.label!;
      const line = n.line ?? 0;
      const column = n.column ?? 0;

      if (prompt.length > 300) {
        throw new DirectiveParseError(
          `":ask" prompt must be 300 characters or fewer (got ${prompt.length})`,
          slug,
          line,
          column,
          'ask',
          'invalid-attr',
        );
      }

      return { params: { prompt } };
    },
    toText(node: unknown) {
      const n = node as DirectiveNode;
      return `Ask Joule: "${n.label}"`;
    },
  });
}

// Auto-register when this module is imported as a side-effect.
// Tests that need isolation call resetRegistry() then registerUiDirectives() explicitly.
registerUiDirectives();
