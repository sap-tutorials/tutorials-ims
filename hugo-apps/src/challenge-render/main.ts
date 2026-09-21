// hugo-apps/src/challenge-render/main.ts
//
// RESEARCH SPIKE (#2362) — island entry for the json-render challenge widget.
//
// Mirrors validation/main.ts: reads the per-step spec out of the
// <script id="tutorial-data"> JSON, finds each `.step-challenge-mount` marker,
// and mounts ChallengeRenderer.vue against the matching step's `challenge`
// spec. Steps without a challenge spec have no marker (see the tutorial-step
// shortcode) so this is a clean no-op for them — the same "island queries a
// selector, absent markers are harmless" idiom the branch/skip islands use.
import { createApp } from 'vue';
import ChallengeRenderer from './ChallengeRenderer.vue';

// Local shape — matches the public spec emitted by srv/lib/ai-challenge-spec.js
// and consumed by ChallengeRenderer.vue. Kept here (not imported from the .vue)
// because <script setup> interface exports aren't importable.
interface ChallengeNode {
  id: string;
  type: string;
  text?: string;
  prompt?: string;
  options?: string[];
  answerIndex?: number;
  aiGraded?: boolean;
}

interface StepData {
  number: number;
  challenge?: { nodes: ChallengeNode[] };
}

const dataEl = document.getElementById('tutorial-data');
if (dataEl) {
  let steps: StepData[];
  try {
    let parsed = JSON.parse(dataEl.textContent || '[]');
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    steps = parsed;
  } catch {
    steps = [];
  }

  const stepByNum = new Map(steps.map((s) => [s.number, s]));

  // Tutorial slug for the grade endpoint — same source the validation island
  // uses (document.documentElement.dataset.pageSlug), lowercased.
  const slug = (document.documentElement.dataset.pageSlug ?? '').toLowerCase();

  document.querySelectorAll('.step-challenge-mount').forEach((el) => {
    const host = el as HTMLElement;
    const stepNum = Number(host.dataset.step ?? 0);
    const step = stepByNum.get(stepNum);
    if (!step?.challenge?.nodes?.length) return;
    createApp(ChallengeRenderer, { spec: step.challenge, slug, stepNumber: stepNum }).mount(host);
  });
}
