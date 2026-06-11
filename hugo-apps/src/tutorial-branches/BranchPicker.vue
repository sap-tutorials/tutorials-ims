<!-- hugo-apps/src/tutorial-branches/BranchPicker.vue -->
<!--
  Issue #172 PR 3 — branch picker for a single branch-point.
  Renders a <ui5-segmented-button> over props.branches; the selected branch's
  steps are rendered below as <h3>+<pre> (markdown-it deliberately out of
  scope for v1 — see spec §10 for the 12KB chunk budget rationale).
-->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { DecideResponse } from './decide';

interface BranchStep { title: string; body: string; }
interface BranchEntry {
  key: string;
  label: string;
  condition: string | null;
  steps: BranchStep[];
}

interface Props {
  slug: string;
  branchPointId: string;
  groupKey: string;
  branches: BranchEntry[];
  override: string | null;
  decisionsPromise: Promise<DecideResponse | null>;
}

const props = defineProps<Props>();

const CONFIDENCE_THRESHOLD = 0.15;
const storageKey = `tut.branch.tutorial.${props.slug}.${props.branchPointId}`;

const recommendedKey = ref<string | null>(null);
const recommendationKind = ref<string | null>(null);
const recommendationSource = ref<string | null>(null);

function initialKey(): string {
  if (props.override) {
    const m = props.branches.find(b => b.key === props.override);
    if (m) return m.key;
  }
  try {
    const persisted = localStorage.getItem(storageKey);
    if (persisted && props.branches.some(b => b.key === persisted)) return persisted;
  } catch { /* localStorage may throw in private mode */ }
  return props.branches[0]?.key ?? '';
}

const selectedKey = ref<string>(initialKey());

const recommendationReason = computed<string | null>(() => {
  if (!recommendedKey.value) return null;
  if (recommendationKind.value === 'condition' && recommendationSource.value) {
    return `Recommended because ${recommendationSource.value}`;
  }
  if (recommendationKind.value === 'ranker') {
    return `Recommended based on tutorials you've completed`;
  }
  return null;
});

onMounted(async () => {
  const decisions = await props.decisionsPromise;
  if (!decisions) return;
  const bp = decisions.branchPoints.find(b => b.id === props.branchPointId);
  if (!bp?.recommendation) return;
  if (bp.recommendation.confidence < CONFIDENCE_THRESHOLD) return;
  if (!props.branches.some(b => b.key === bp.recommendation!.picked)) return;
  recommendedKey.value = bp.recommendation.picked;
  recommendationKind.value = bp.recommendation.reason.kind;
  recommendationSource.value = bp.recommendation.reason.source ?? null;
  // Adopt recommendation only when the user has not already chosen something
  // (no override + no localStorage) AND the current selection is the bare
  // first-branch fallback.
  let hasPersisted = false;
  try { hasPersisted = !!localStorage.getItem(storageKey); } catch { /* ignore */ }
  if (!props.override && !hasPersisted && selectedKey.value === props.branches[0]?.key) {
    selectedKey.value = bp.recommendation.picked;
  }
});

function onItemClick(key: string) {
  if (key === selectedKey.value) return;
  selectedKey.value = key;
  try { localStorage.setItem(storageKey, key); } catch { /* ignore */ }
}
</script>

<template>
  <div class="branch-picker">
    <ui5-segmented-button accessible-name="Branch options">
      <ui5-segmented-button-item
        v-for="branch in branches"
        :key="branch.key"
        :selected="branch.key === selectedKey || undefined"
        :data-recommended="branch.key === recommendedKey ? 'true' : undefined"
        @click="onItemClick(branch.key)"
      >
        <ui5-icon
          v-if="branch.key === recommendedKey"
          name="ai"
          slot="icon"
        />
        {{ branch.label }}
      </ui5-segmented-button-item>
    </ui5-segmented-button>

    <div
      v-if="recommendedKey && recommendedKey !== selectedKey && recommendationReason"
      class="branch-recommendation"
    >
      {{ recommendationReason }}
    </div>

    <div
      v-for="branch in branches"
      v-show="selectedKey === branch.key"
      :key="branch.key"
      class="branch-content"
    >
      <template v-for="(step, si) in branch.steps" :key="si">
        <h3>{{ step.title }}</h3>
        <pre style="white-space:pre-wrap; font-family:inherit;">{{ step.body }}</pre>
      </template>
    </div>
  </div>
</template>

<style scoped>
.branch-picker { margin: 1rem 0; }
.branch-recommendation {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
}
.branch-content { margin-top: 1rem; }
</style>
