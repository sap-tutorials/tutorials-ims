// scripts/parsers/os-classifier.ts

export const OS_VALUES = ['Windows', 'macOS', 'Linux', 'BAS'] as const;
export type OS = typeof OS_VALUES[number];

// Order matters — multi-OS labels must match before single-OS labels.
const RULES: Array<{ pattern: RegExp; oses: OS[] }> = [
  { pattern: /^(mac\s*(?:os)?|os\s*x)\s*(?:and|&|\/|,)\s*linux$/i,        oses: ['macOS', 'Linux'] },
  { pattern: /^linux\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|os\s*x)$/i,      oses: ['Linux', 'macOS'] },
  // Three-way labels — must precede the two-way and single-OS rules.
  // Match orderings: Windows + Mac/MacOS + Linux (any of "and"/"&"/","/"/" separators)
  { pattern: /^(?:windows|win)\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|os\s*x)\s*(?:and|&|\/|,)\s*linux$/i,
    oses: ['Windows', 'macOS', 'Linux'] },
  { pattern: /^(?:windows|win)\s*(?:and|&|\/|,)\s*linux\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|os\s*x)$/i,
    oses: ['Windows', 'Linux', 'macOS'] },
  // Two-way labels involving Windows
  { pattern: /^(?:windows|win)\s*(?:and|&|\/|,)\s*(?:mac\s*(?:os)?|os\s*x)$/i,
    oses: ['Windows', 'macOS'] },
  { pattern: /^(?:mac\s*(?:os)?|os\s*x)\s*(?:and|&|\/|,)\s*(?:windows|win)$/i,
    oses: ['macOS', 'Windows'] },
  { pattern: /^(?:windows|win)\s*(?:and|&|\/|,)\s*linux$/i,
    oses: ['Windows', 'Linux'] },
  { pattern: /^linux\s*(?:and|&|\/|,)\s*(?:windows|win)$/i,
    oses: ['Linux', 'Windows'] },
  { pattern: /^(?:mac\s*os|macos|mac|os\s*x|darwin)$/i,                    oses: ['macOS'] },
  { pattern: /^(?:windows|win|win32|win64)$/i,                             oses: ['Windows'] },
  { pattern: /^(?:linux|ubuntu|debian|fedora|unix)$/i,                     oses: ['Linux'] },
  { pattern: /^(?:bas|business\s*application\s*studio|sap\s*bas)$/i,       oses: ['BAS'] },
];

export interface ClassifyResult {
  kind: 'os' | 'regular';
  /** Source tab label → list of canonical OSes that label maps to. */
  assignments: Map<string, OS[]>;
}

export function classifyTab(label: string): OS[] | null {
  const trimmed = label.trim();
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return [...rule.oses];
  }
  return null;
}

export function classifyGroup(labels: string[]): ClassifyResult {
  const assignments = new Map<string, OS[]>();
  for (const label of labels) {
    const oses = classifyTab(label);
    if (!oses) return { kind: 'regular', assignments: new Map() };
    assignments.set(label, oses);
  }
  // Sanity: at least 2 distinct canonical OSes covered. A lone "[Windows]"
  // block with no peer doesn't deserve a global picker.
  const distinct = new Set([...assignments.values()].flat());
  if (distinct.size < 2) return { kind: 'regular', assignments: new Map() };
  return { kind: 'os', assignments };
}

/**
 * Force-classify when an author override marks a group as `os`. Skips the
 * sanity rejection that `classifyGroup` enforces, but still rejects labels
 * that don't match any rule (returns kind: 'regular' if any label fails to
 * classify — author override can override the heuristic but cannot invent
 * OS semantics for unrecognized labels).
 */
export function forceClassify(labels: string[]): ClassifyResult {
  const assignments = new Map<string, OS[]>();
  for (const label of labels) {
    const oses = classifyTab(label);
    if (!oses) return { kind: 'regular', assignments: new Map() };
    assignments.set(label, oses);
  }
  return { kind: 'os', assignments };
}
