// @vitest-environment happy-dom
//
// Issue #172 PR 4 — covers the publish/subscribe round-trip for the cross-
// component branch state bus. Used by BranchPicker.vue (publish) and the
// page reader in u1-object-page.html (subscribe).

import { describe, it, expect } from 'vitest';
import { publishBranchState, subscribeBranchState } from '../branch-state-bus';

describe('branch-state-bus', () => {
  it('publish + subscribe round-trip delivers the state', () => {
    const received: any[] = [];
    const unsubscribe = subscribeBranchState(s => received.push(s));

    publishBranchState({
      branchPointId: '1-deployment',
      groupKey: 'deployment',
      currentBranch: 'hana',
      recommendedBranch: 'hana',
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      branchPointId: '1-deployment',
      groupKey: 'deployment',
      currentBranch: 'hana',
      recommendedBranch: 'hana',
    });

    unsubscribe();
  });

  it('multiple subscribers all receive the state', () => {
    const received1: any[] = [];
    const received2: any[] = [];
    const unsub1 = subscribeBranchState(s => received1.push(s));
    const unsub2 = subscribeBranchState(s => received2.push(s));

    publishBranchState({
      branchPointId: '2-storage', groupKey: 'storage',
      currentBranch: 's3', recommendedBranch: 's3',
    });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    unsub1(); unsub2();
  });

  it('unsubscribe stops delivery', () => {
    const received: any[] = [];
    const unsubscribe = subscribeBranchState(s => received.push(s));
    unsubscribe();

    publishBranchState({
      branchPointId: '1-deployment', groupKey: 'deployment',
      currentBranch: 'hana', recommendedBranch: 'hana',
    });

    expect(received).toHaveLength(0);
  });
});
