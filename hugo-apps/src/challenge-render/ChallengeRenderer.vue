<script setup lang="ts">
// hugo-apps/src/challenge-render/ChallengeRenderer.vue
//
// RESEARCH SPIKE (#2362) — the json-render "renderer" layer.
//
// Takes a challenge UI spec (the typed node tree emitted by
// srv/lib/ai-challenge-spec.js) and maps each node's `type` to a real
// component via a catalog registry — the guardrailed json-render pattern.
// Unknown node types are skipped, never executed: the renderer only ever
// mounts allow-listed components, so a malformed/hostile spec cannot inject
// markup or behaviour.
import { computed } from 'vue';

export interface ChallengeNode {
  id: string;
  type: string;
  text?: string;
  prompt?: string;
  options?: string[];
  answerIndex?: number;
  aiGraded?: boolean;
}

const props = defineProps<{ spec: { nodes: ChallengeNode[] } | null }>();

// The catalog: node type -> the set of allow-listed types the renderer knows.
// Mirrors CATALOG in srv/lib/ai-challenge-spec.js. A node whose type is not
// here is dropped (never rendered) — the core json-render safety guarantee.
const KNOWN = new Set(['heading', 'prose', 'mcq', 'freeText']);

const nodes = computed(() => (props.spec?.nodes ?? []).filter((n) => KNOWN.has(n.type)));
</script>

<template>
  <section v-if="nodes.length" class="challenge-panel" aria-label="Practice challenge">
    <template v-for="node in nodes" :key="node.id">
      <h3 v-if="node.type === 'heading'" class="challenge-heading">{{ node.text }}</h3>

      <p v-else-if="node.type === 'prose'" class="challenge-prose">{{ node.text }}</p>

      <fieldset v-else-if="node.type === 'mcq'" class="challenge-mcq" :data-node-id="node.id">
        <legend>{{ node.prompt }}</legend>
        <label v-for="(opt, i) in node.options" :key="i" class="challenge-option">
          <input type="radio" :name="node.id" :value="i" /> {{ opt }}
        </label>
      </fieldset>

      <div v-else-if="node.type === 'freeText'" class="challenge-freetext" :data-node-id="node.id">
        <label :for="node.id">{{ node.prompt }}</label>
        <textarea :id="node.id" rows="3"></textarea>
        <p v-if="node.aiGraded" class="challenge-ai-note">Graded by AI.</p>
      </div>
    </template>
  </section>
</template>
