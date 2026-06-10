// hugo-apps/src/tutorial-branches/main.ts
//
// Issue #172 PR 3 — Vue island that hydrates three surfaces:
//   1. Per-branch-point: <ui5-segmented-button> picker (BranchPicker.vue)
//   2. Per-skip-step: <ui5-message-strip> skip prompt (SkipPrompt.vue)
//   3. Mission-side-nav alt-group chip recommendation (MissionAltGroupHighlight.vue)
//
// Uses createApp (not createSSRApp) per [[feedback_vue_fragment_hydration_mismatch]].
// Reads slug from document.documentElement.dataset.pageSlug per [[feedback_island_slug_source]].

import { createApp } from 'vue';
import BranchPicker from './BranchPicker.vue';
import SkipPrompt from './SkipPrompt.vue';
import MissionAltGroupHighlight from './MissionAltGroupHighlight.vue';
import { getDecisions, readBranchOverride } from './decide';

interface BranchEntry {
  key: string;
  label: string;
  condition: string | null;
  steps: Array<{ title: string; body: string }>;
}

interface StepData {
  number: number;
  branchPointId?: string;
  branchGroup?: string;
  branches?: BranchEntry[];
  skipIf?: string;
  skipLabel?: string;
  skipReason?: string;
}

function readSteps(): StepData[] {
  const dataEl = document.getElementById('tutorial-data');
  if (!dataEl) return [];
  try {
    let parsed = JSON.parse(dataEl.textContent || '[]');
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed as StepData[];
  } catch {
    return [];
  }
}

function init(): void {
  const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();
  const steps = readSteps();
  const stepByNum = new Map(steps.map(s => [s.number, s]));
  const stepByBranchPointId = new Map(
    steps.filter(s => s.branchPointId).map(s => [s.branchPointId!, s])
  );

  const branchMounts = document.querySelectorAll<HTMLElement>('.tutorial-branch-mount');
  const skipMounts = document.querySelectorAll<HTMLElement>('.tutorial-skip-mount');
  const altGroupRoot = document.querySelector<HTMLElement>('[data-altgroup-needs-hydration="true"]');

  if (!branchMounts.length && !skipMounts.length && !altGroupRoot) return;

  const decisionsP = getDecisions(slug);
  const override = readBranchOverride();

  branchMounts.forEach((el) => {
    const bpId = el.dataset.branchPointId ?? '';
    const step = stepByBranchPointId.get(bpId);
    if (!step?.branches?.length) {
      console.warn(`[tutorial-branches] mount marker ${bpId} has no matching frontmatter branches`);
      return;
    }
    createApp(BranchPicker, {
      slug,
      branchPointId: bpId,
      groupKey: step.branchGroup ?? '',
      branches: step.branches,
      override: override?.groupKey === step.branchGroup ? override.branchKey : null,
      decisionsPromise: decisionsP,
    }).mount(el);
  });

  skipMounts.forEach((el) => {
    const stepNum = Number(el.dataset.step ?? 0);
    const step = stepByNum.get(stepNum);
    if (!step?.skipIf) return;
    createApp(SkipPrompt, {
      slug,
      stepNumber: stepNum,
      skipLabel: step.skipLabel ?? 'Skip this step',
      skipReason: step.skipReason ?? '',
      decisionsPromise: decisionsP,
    }).mount(el);
  });

  if (altGroupRoot) {
    createApp(MissionAltGroupHighlight, {}).mount(altGroupRoot);
  }
}

if (customElements.get('ui5-segmented-button')) {
  init();
} else {
  void customElements.whenDefined('ui5-segmented-button').then(() => init());
}

export {};
