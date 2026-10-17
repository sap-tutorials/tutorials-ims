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
