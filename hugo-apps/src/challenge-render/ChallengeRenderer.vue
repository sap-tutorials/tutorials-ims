<script setup lang="ts">
// hugo-apps/src/challenge-render/ChallengeRenderer.vue
//
// RESEARCH SPIKE (#2362) — the json-render "renderer" layer.
// Grading wired in #2441.
//
// Takes a challenge UI spec (the typed node tree emitted by
// srv/lib/ai-challenge-spec.js) and maps each node's `type` to a real
// component via a catalog registry — the guardrailed json-render pattern.
// Unknown node types are skipped, never executed: the renderer only ever
// mounts allow-listed components, so a malformed/hostile spec cannot inject
// markup or behaviour.
//
// Grading (#2441):
//   - mcq:      client-graded against the public `answerIndex` (no server call).
//   - freeText: AI-graded server-side via POST /api/challenge-grade (the
//               reference answer is server-only; see srv/lib/challenge-grade-*).
import { computed, reactive } from 'vue';
import { csrfFetch } from '@shared/csrf-fetch';

export interface ChallengeNode {
  id: string;
  type: string;
  text?: string;
  prompt?: string;
  options?: string[];
  answerIndex?: number;
  aiGraded?: boolean;
}

const props = withDefaults(defineProps<{
  spec: { nodes: ChallengeNode[] } | null;
  slug?: string;
  stepNumber?: number;
  // When true (author preview), never POST to the grade endpoint.
  isPreview?: boolean;
}>(), { slug: '', stepNumber: 0, isPreview: false });

// The catalog: node type -> the set of allow-listed types the renderer knows.
// Mirrors CATALOG in srv/lib/ai-challenge-spec.js. A node whose type is not
// here is dropped (never rendered) — the core json-render safety guarantee.
const KNOWN = new Set(['heading', 'prose', 'mcq', 'freeText']);

const nodes = computed(() => (props.spec?.nodes ?? []).filter((n) => KNOWN.has(n.type)));

// Per-node interactive state, keyed by node id.
interface NodeState {
  selected: number | null;   // mcq radio selection
  answer: string;            // freeText textarea
  status: 'idle' | 'grading' | 'correct' | 'incorrect' | 'partial' | 'error';
  message: string;           // verdict summary / hint / error text
}
const state = reactive<Record<string, NodeState>>({});
function stateFor(id: string): NodeState {
  if (!state[id]) state[id] = { selected: null, answer: '', status: 'idle', message: '' };
  return state[id];
}

// mcq: client-graded against the public answerIndex.
function submitMcq(node: ChallengeNode) {
  const s = stateFor(node.id);
  if (s.selected == null) { s.status = 'error'; s.message = 'Select an option first.'; return; }
  if (s.selected === node.answerIndex) {
    s.status = 'correct';
    s.message = 'Correct.';
  } else {
    s.status = 'incorrect';
    s.message = 'Not quite — try again.';
  }
}

// freeText: AI-graded server-side.
async function submitFreeText(node: ChallengeNode) {
  const s = stateFor(node.id);
  const submittedAnswer = s.answer.trim();
  if (!submittedAnswer) { s.status = 'error'; s.message = 'Enter an answer first.'; return; }
  if (props.isPreview) { s.status = 'idle'; s.message = 'Grading is disabled in preview.'; return; }

  s.status = 'grading';
  s.message = '';
  try {
    const res = await csrfFetch('/api/challenge-grade', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tutorialSlug: props.slug,
        stepNumber: props.stepNumber,
        nodeId: node.id,
        submittedAnswer,
      }),
    });
    if (!res.ok) {
      s.status = 'error';
      s.message = res.status === 503 ? 'Grading is currently unavailable.' : 'Could not grade your answer.';
      return;
    }
    const body = await res.json();
    if (body.verdict === 'pass') { s.status = 'correct'; s.message = body.summary || 'Correct.'; }
    else if (body.verdict === 'partial') { s.status = 'partial'; s.message = body.hint || body.summary || 'Partially correct.'; }
    else if (body.verdict === 'fail') { s.status = 'incorrect'; s.message = body.summary || 'Not quite — try again.'; }
    else { s.status = 'error'; s.message = 'Could not grade your answer.'; }
  } catch {
    s.status = 'error';
    s.message = 'Could not reach the grader.';
  }
}
</script>

<template>
  <section v-if="nodes.length" class="challenge-panel" aria-label="Practice challenge">
    <template v-for="node in nodes" :key="node.id">
      <h3 v-if="node.type === 'heading'" class="challenge-heading">{{ node.text }}</h3>

      <p v-else-if="node.type === 'prose'" class="challenge-prose">{{ node.text }}</p>

      <fieldset v-else-if="node.type === 'mcq'" class="challenge-mcq" :data-node-id="node.id">
        <legend>{{ node.prompt }}</legend>
        <label v-for="(opt, i) in node.options" :key="i" class="challenge-option">
          <input type="radio" :name="node.id" :value="i" v-model.number="stateFor(node.id).selected" /> {{ opt }}
        </label>
        <button type="button" class="challenge-check" @click="submitMcq(node)">Check</button>
        <p v-if="stateFor(node.id).message"
           class="challenge-verdict"
           :data-status="stateFor(node.id).status"
           role="status">{{ stateFor(node.id).message }}</p>
      </fieldset>

      <div v-else-if="node.type === 'freeText'" class="challenge-freetext" :data-node-id="node.id">
        <label :for="node.id">{{ node.prompt }}</label>
        <textarea :id="node.id" rows="3" v-model="stateFor(node.id).answer"></textarea>
        <p v-if="node.aiGraded" class="challenge-ai-note">Graded by AI.</p>
        <button type="button"
                class="challenge-check"
                :disabled="stateFor(node.id).status === 'grading'"
                @click="submitFreeText(node)">
          {{ stateFor(node.id).status === 'grading' ? 'Checking…' : 'Check' }}
        </button>
        <p v-if="stateFor(node.id).message"
           class="challenge-verdict"
           :data-status="stateFor(node.id).status"
           role="status">{{ stateFor(node.id).message }}</p>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* Horizon design tokens with hex fallbacks — matches the Validation island's
   conventions (bordered card, rem spacing). */
.challenge-panel {
  border: 1px solid var(--sapNeutralBorderColor, #e5e5e5);
  border-radius: 0.5rem;
  padding: 1rem 1.25rem;
  margin: 1.5rem 0;
  background-color: var(--sapNeutralBackground, rgba(120, 143, 166, 0.04));
}
.challenge-heading {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
  font-weight: 700;
}
.challenge-prose {
  margin: 0 0 1rem;
}
.challenge-mcq {
  border: 1px solid var(--sapNeutralBorderColor, #e5e5e5);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  margin: 0 0 1rem;
}
.challenge-mcq legend {
  font-weight: 600;
  padding: 0 0.25rem;
}
/* Each radio + label on its own line — the core fix for the run-together bug. */
.challenge-option {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  padding: 0.375rem 0;
  cursor: pointer;
}
.challenge-option input {
  flex-shrink: 0;
}
.challenge-freetext {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin: 0 0 0.5rem;
}
.challenge-freetext label {
  font-weight: 600;
}
.challenge-freetext textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: 0.375rem;
  font: inherit;
  resize: vertical;
}
.challenge-ai-note {
  margin: 0.25rem 0 0;
  font-size: 0.8125rem;
  color: var(--sapContent_LabelColor, #556b82);
}
.challenge-check {
  align-self: flex-start;
  margin-top: 0.5rem;
  padding: 0.375rem 1rem;
  border: 1px solid var(--sapButton_BorderColor, #0064d9);
  border-radius: 0.375rem;
  background: var(--sapButton_Background, #fff);
  color: var(--sapButton_TextColor, #0064d9);
  font: inherit;
  cursor: pointer;
}
.challenge-check:disabled {
  opacity: 0.6;
  cursor: default;
}
.challenge-verdict {
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
}
.challenge-verdict[data-status='correct'] { color: var(--sapPositiveTextColor, #256f3a); }
.challenge-verdict[data-status='incorrect'],
.challenge-verdict[data-status='error'] { color: var(--sapNegativeTextColor, #aa0808); }
.challenge-verdict[data-status='partial'] { color: var(--sapCriticalTextColor, #a45500); }
</style>
