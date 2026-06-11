// hugo-apps/src/tutorial-branches/branch-state-bus.ts
//
// Issue #172 PR 4 — cross-component state bus for branch picker → page reader.
// BranchPicker.vue calls publishBranchState() whenever its selected or
// recommended branch changes. The page-level script in u1-object-page.html
// calls subscribeBranchState() to maintain a Map per branchPointId, which
// opGetCurrentStep() and joule.js#readPageContext both read.
//
// Uses CustomEvent on document — no global window namespace pollution,
// no Vue dependency in the subscriber. Tree-shakable (subscribe path stays
// out of the island bundle when the island only publishes).
//
// Spec: docs/superpowers/specs/2026-06-11-172-branching-pr4-joule-narration-design.md §4.4

export interface BranchState {
  branchPointId: string;
  groupKey: string;
  currentBranch: string;
  recommendedBranch: string | null;
}

const EVENT = 'branch:state-change';

export function publishBranchState(state: BranchState): void {
  document.dispatchEvent(new CustomEvent(EVENT, { detail: state }));
}

export function subscribeBranchState(handler: (state: BranchState) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<BranchState>).detail);
  document.addEventListener(EVENT, listener);
  return () => document.removeEventListener(EVENT, listener);
}
