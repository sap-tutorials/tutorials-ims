// scripts/parsers/branches.ts
//
// Issue #172 PR 3 — strict pre-pass parser for [BRANCH_BEGIN]…[BRANCH_END]
// markers. Runs BEFORE v2.ts step-walker; rewrites the body into a clean
// linear stream and returns structured branchGroups for attachment to the
// parent step's frontmatter.
//
// Spec: docs/superpowers/specs/2026-06-10-172-branching-pr3-tutorial-branches-design.md §4.1
//
// Pure function, no I/O. All errors are thrown as BranchParseError with line
// context so fetch-tutorials.ts can surface them with file path.

import { parseCondition, ConditionParseError } from '../../srv/lib/branch/condition.js';
import { createFenceTracker } from './fence-tracker.js';

export class BranchParseError extends Error {
  line: number;
  slug: string;
  constructor(message: string, line: number, slug: string) {
    super(`${message} (${slug}:${line})`);
    this.name = 'BranchParseError';
    this.line = line;
    this.slug = slug;
  }
}

export interface BranchSubStep {
  title: string;
  body: string;
}

export interface Branch {
  key: string;
  label: string;
  condition: string | null;
  embeddingHint: string | null;
  steps: BranchSubStep[];
  /** Internal: 1-based source line where this branch's [BRANCH_BEGIN] appeared. Used for error reporting. */
  _beginLine?: number;
}

export interface BranchGroup {
  id: string;
  parentStepNumber: number;
  groupKey: string;
  /** 1-based source line of the FIRST [BRANCH_BEGIN] in this group. Used by lint rules. */
  beginLine: number;
  branches: Branch[];
}

export interface ExtractResult {
  rewrittenBody: string;
  branchGroups: BranchGroup[];
}

const BRANCH_BEGIN_RE = /^\s*\[BRANCH_BEGIN\s+([^\]]+)\]\s*$/;
const BRANCH_END_RE = /^\s*\[BRANCH_END\]\s*$/;
const H3_RE = /^###\s+(.+?)\s*$/;
const ATTR_RE = /(\w+)="((?:[^"\\]|\\.)*)"/g;

interface MarkerAttrs {
  group: string;
  key: string;
  label: string;
  condition: string | null;
}

function parseMarkerAttrs(raw: string, line: number, slug: string): MarkerAttrs {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    // Unescape \" → " and \\ → \ in the captured value
    const value = m[2].replace(/\\(.)/g, '$1');
    attrs[m[1]] = value;
  }
  if (!attrs.group) {
    throw new BranchParseError('[BRANCH_BEGIN] missing group= attribute', line, slug);
  }
  if (!attrs.key) {
    throw new BranchParseError('[BRANCH_BEGIN] missing key= attribute', line, slug);
  }
  if (!attrs.label) {
    throw new BranchParseError('[BRANCH_BEGIN] missing label= attribute', line, slug);
  }
  return {
    group: attrs.group,
    key: attrs.key,
    label: attrs.label,
    condition: attrs.condition ?? null,
  };
}

function sliceSubSteps(lines: string[], slug: string, baseLine: number): BranchSubStep[] {
  const steps: BranchSubStep[] = [];
  let current: BranchSubStep | null = null;
  const fence = createFenceTracker();
  for (const line of lines) {
    if (fence(line)) {
      if (current) {
        current.body += (current.body ? '\n' : '') + line;
      }
      continue;
    }
    const h3 = line.match(H3_RE);
    if (h3) {
      if (current) {
        current.body = current.body.replace(/^\n+|\n+$/g, '');
        steps.push(current);
      }
      current = { title: h3[1], body: '' };
    } else if (current) {
      current.body += (current.body ? '\n' : '') + line;
    }
    // Lines before the first H3 are dropped (whitespace/blank between
    // [BRANCH_BEGIN] and the first H3 sub-step).
  }
  if (current) {
    current.body = current.body.replace(/^\n+|\n+$/g, '');
    steps.push(current);
  }
  if (steps.length === 0) {
    throw new BranchParseError('branch has no H3 sub-steps', baseLine, slug);
  }
  return steps;
}

function countParentStepBefore(
  lines: string[],
  beginIdx: number,
  consumedRanges: Array<[number, number]>,
): number {
  let n = 0;
  const fence = createFenceTracker();
  for (let i = 0; i < beginIdx; i++) {
    // Skip lines inside any previously-consumed [BRANCH_BEGIN]…[BRANCH_END]
    // block — their H3s belong to a sub-step, not the parent stream. The
    // fence tracker also doesn't advance over consumed lines, matching the
    // original behavior: a malformed (unclosed) fence inside a consumed
    // branch can't bleed into the outer stream.
    let insideConsumed = false;
    for (const [start, end] of consumedRanges) {
      if (i >= start && i <= end) {
        insideConsumed = true;
        break;
      }
    }
    if (insideConsumed) continue;
    if (fence(lines[i])) continue;
    if (H3_RE.test(lines[i])) n++;
  }
  return n;
}

interface PendingGroup {
  groupKey: string;
  parentStepNumber: number;
  branches: Branch[];
}

export function extractBranchGroups(body: string, slug: string): ExtractResult {
  if (!body.includes('[BRANCH_BEGIN') && !body.includes('[BRANCH_END')) {
    return { rewrittenBody: body, branchGroups: [] };
  }

  const lines = body.split('\n');
  const out: string[] = [];
  const branchGroups: BranchGroup[] = [];
  let pendingGroup: PendingGroup | null = null;
  const consumedRanges: Array<[number, number]> = [];

  function flushGroup(): void {
    if (!pendingGroup) return;
    const seen = new Set<string>();
    for (const b of pendingGroup.branches) {
      if (seen.has(b.key)) {
        throw new BranchParseError(
          `duplicate key "${b.key}" within group "${pendingGroup.groupKey}"`,
          b._beginLine ?? 0,
          slug,
        );
      }
      seen.add(b.key);
    }
    branchGroups.push({
      id: `${pendingGroup.parentStepNumber}-${pendingGroup.groupKey}`,
      parentStepNumber: pendingGroup.parentStepNumber,
      groupKey: pendingGroup.groupKey,
      beginLine: pendingGroup.branches[0]._beginLine ?? 0,
      branches: pendingGroup.branches.map(({ _beginLine, ...rest }) => rest),
    });
    pendingGroup = null;
  }

  let i = 0;
  const fence = createFenceTracker();
  while (i < lines.length) {
    const line = lines[i];

    // Inside a fenced code block, skip ALL marker detection so meta-tutorials
    // documenting the [BRANCH_BEGIN]/[BRANCH_END] syntax don't false-trigger.
    // Uses the shared fence tracker (handles ``` and ~~~, run-length-aware
    // close — see scripts/parsers/fence-tracker.ts).
    if (fence(line)) {
      if (pendingGroup && line.trim() !== '') {
        flushGroup();
      }
      out.push(line);
      i++;
      continue;
    }

    const beginMatch = line.match(BRANCH_BEGIN_RE);

    if (!beginMatch) {
      if (BRANCH_END_RE.test(line)) {
        throw new BranchParseError(
          '[BRANCH_END] without matching [BRANCH_BEGIN]',
          i + 1,
          slug,
        );
      }
      // Non-blank non-marker line closes any open pendingGroup.
      if (pendingGroup && line.trim() !== '') {
        flushGroup();
      }
      out.push(line);
      i++;
      continue;
    }

    // Found [BRANCH_BEGIN].
    const beginIdx = i;
    const beginLine = i + 1;
    const attrs = parseMarkerAttrs(beginMatch[1], beginLine, slug);

    // Find matching [BRANCH_END]; reject nested begins.
    let endIdx = -1;
    for (let j = beginIdx + 1; j < lines.length; j++) {
      if (BRANCH_BEGIN_RE.test(lines[j])) {
        throw new BranchParseError(
          `nested [BRANCH_BEGIN] inside another branch starting at line ${beginLine}`,
          j + 1,
          slug,
        );
      }
      if (BRANCH_END_RE.test(lines[j])) {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) {
      throw new BranchParseError(
        `unbalanced [BRANCH_BEGIN] starting at line ${beginLine}, no matching [BRANCH_END]`,
        beginLine,
        slug,
      );
    }

    if (attrs.condition !== null) {
      try {
        parseCondition(attrs.condition);
      } catch (err) {
        if (err instanceof ConditionParseError) {
          throw new BranchParseError(
            `condition "${attrs.condition}" does not parse: ${err.message}`,
            beginLine,
            slug,
          );
        }
        throw err;
      }
    }

    const innerLines = lines.slice(beginIdx + 1, endIdx);
    const steps = sliceSubSteps(innerLines, slug, beginLine);
    const branch: Branch = {
      key: attrs.key,
      label: attrs.label,
      condition: attrs.condition,
      embeddingHint: steps[0]?.title ?? null,
      steps,
      _beginLine: beginLine,
    };

    const parentStepNumber = countParentStepBefore(lines, beginIdx, consumedRanges);

    if (
      pendingGroup &&
      pendingGroup.parentStepNumber === parentStepNumber &&
      pendingGroup.groupKey === attrs.group
    ) {
      pendingGroup.branches.push(branch);
    } else if (
      pendingGroup &&
      pendingGroup.parentStepNumber === parentStepNumber &&
      pendingGroup.groupKey !== attrs.group
    ) {
      throw new BranchParseError(
        `branch at line ${beginLine} has group="${attrs.group}" but its sibling has group="${pendingGroup.groupKey}"`,
        beginLine,
        slug,
      );
    } else {
      flushGroup();
      pendingGroup = {
        groupKey: attrs.group,
        parentStepNumber,
        branches: [branch],
      };
    }

    // Skip the entire [BRANCH_BEGIN]…[BRANCH_END] block (do not emit to out).
    consumedRanges.push([beginIdx, endIdx]);
    i = endIdx + 1;
  }

  flushGroup();

  return { rewrittenBody: out.join('\n'), branchGroups };
}
