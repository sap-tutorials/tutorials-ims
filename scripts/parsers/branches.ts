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
}

export interface BranchGroup {
  id: string;
  parentStepNumber: number;
  groupKey: string;
  branches: Branch[];
}

export interface ExtractResult {
  rewrittenBody: string;
  branchGroups: BranchGroup[];
}

export function extractBranchGroups(body: string, slug: string): ExtractResult {
  // Subsequent tasks fill in the implementation. For now, no markers → no-op.
  if (!body.includes('[BRANCH_BEGIN')) {
    return { rewrittenBody: body, branchGroups: [] };
  }
  // Placeholder until Task 3.
  throw new BranchParseError('parser not yet implemented', 0, slug);
}
