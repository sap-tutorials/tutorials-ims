// hugo-apps/src/tutorial-variables/substitution.ts
//
// Pure helpers for the tutorial-variables island.
// Exported separately from main.ts so vitest can import them
// without triggering DOM-mount side-effects.

// ──────────────────────────────────────────────────────────────────────────────
// Types (shared with main.ts and tests)
// ──────────────────────────────────────────────────────────────────────────────

export interface TutorialVariableDefault {
  from: 'email' | 'id' | 'givenName' | 'familyName';
  pattern: string;
}

export interface TutorialVariable {
  name: string;
  label: string;
  type: 'string' | 'number';
  maxLength?: number;
  required?: boolean;
  placeholder?: string;
  default?: TutorialVariableDefault;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sentinel pattern — must match the one in scripts/parsers/variables.ts
// ──────────────────────────────────────────────────────────────────────────────

const SENTINEL_PATTERN = /TUTVARx([A-Za-z0-9_]+)x/g;

// ──────────────────────────────────────────────────────────────────────────────
// expandSentinels
//
// Walks the DOM under `root`, finds text nodes containing the sentinel pattern
// `TUTVARx<NAME>x` and replaces each occurrence with a real
// `<span class="tut-var" data-tut-var="NAME"></span>` element.
//
// This is the client-side counterpart of the build-time sentinel injection.
// It handles two cases:
//   1. Inline-code spans: `wrapTokens` emits `TUTVARxNAMEx` inside backtick
//      runs because Goldmark HTML-escapes `<code>` content — a raw `<span>`
//      would become escaped literal text. The sentinel survives as safe
//      letters-only text; `expandSentinels` converts it at mount.
//   2. Safety net for any fenced sentinel that survived (e.g. if the Hugo
//      render hook was not applied). The hook creates spans at build time, so
//      this branch is normally a no-op in production — but keeps things robust.
//
// Safety:
//   - Variable names match `[A-Za-z0-9_]+` (validated at build time); no
//     user-controlled content is injected unescaped.
//   - Span elements are built via createElement/setAttribute/textContent —
//     NEVER innerHTML — so there is zero XSS surface.
//   - Only TEXT nodes are visited; already-built `[data-tut-var]` spans are
//     never re-processed (they don't contain the sentinel literal).
//
// @param root  The root node to search under (defaults to `document`).
// @returns     The number of sentinel occurrences expanded.
// ──────────────────────────────────────────────────────────────────────────────

export function expandSentinels(root: ParentNode = document): number {
  let expanded = 0;

  // Collect text nodes that contain the sentinel via a TreeWalker.
  // SHOW_TEXT (4) visits only text nodes; the filter keeps only nodes whose
  // data contains the sentinel pattern (fast string check before regex).
  const walker = document.createTreeWalker(
    root as Node,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node: Text): number {
        return node.data.includes('TUTVARx')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );

  // Collect all matching text nodes first (modifying the DOM while walking
  // causes the TreeWalker to skip nodes).
  const textNodes: Text[] = [];
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null) !== null) {
    textNodes.push(node);
  }

  for (const textNode of textNodes) {
    const data = textNode.data;
    SENTINEL_PATTERN.lastIndex = 0;

    // Check if the node actually has a sentinel (the walker filter is a
    // quick-and-dirty string check; confirm with the real regex).
    if (!SENTINEL_PATTERN.test(data)) continue;
    SENTINEL_PATTERN.lastIndex = 0;

    // Split the text node's content around sentinel occurrences and build a
    // DocumentFragment with text + span nodes interleaved.
    const frag = document.createDocumentFragment();
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = SENTINEL_PATTERN.exec(data)) !== null) {
      const sentinelStart = m.index;
      const sentinelEnd = sentinelStart + m[0].length;
      const name = m[1]; // already validated as [A-Za-z0-9_]+

      // Text before the sentinel
      if (sentinelStart > lastIndex) {
        frag.appendChild(document.createTextNode(data.slice(lastIndex, sentinelStart)));
      }

      // Build the span element safely — no innerHTML
      const span = document.createElement('span');
      span.className = 'tut-var';
      span.setAttribute('data-tut-var', name);
      // textContent starts empty; applyValue() will fill it in
      frag.appendChild(span);

      lastIndex = sentinelEnd;
      expanded++;
    }

    // Remaining text after the last sentinel
    if (lastIndex < data.length) {
      frag.appendChild(document.createTextNode(data.slice(lastIndex)));
    }

    // Replace the original text node with the fragment
    textNode.parentNode!.replaceChild(frag, textNode);
  }

  return expanded;
}

// ──────────────────────────────────────────────────────────────────────────────
// applyValue
//
// Sets .textContent of every [data-tut-var="name"] element under `root`
// to `value`. Returns the count of elements updated.
// ──────────────────────────────────────────────────────────────────────────────

export function applyValue(
  name: string,
  value: string,
  root: ParentNode = document,
): number {
  const els = root.querySelectorAll<HTMLElement>(`[data-tut-var="${CSS.escape(name)}"]`);
  els.forEach((el) => {
    el.textContent = value;
  });
  return els.length;
}

// ──────────────────────────────────────────────────────────────────────────────
// resolveDefault
//
// If `v.default` is defined and `identity` is not null, runs the regex pattern
// against `identity[v.default.from]` and returns capture group 1.
// Returns null on: no default, no identity, no match, bad pattern, missing field.
// Never throws.
// ──────────────────────────────────────────────────────────────────────────────

export function resolveDefault(
  v: TutorialVariable,
  identity: Record<string, string> | null,
): string | null {
  if (!v.default || !identity) return null;
  const haystack = identity[v.default.from];
  if (!haystack) return null;
  try {
    const m = new RegExp(v.default.pattern).exec(haystack);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
