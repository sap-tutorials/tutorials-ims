<!-- hugo-apps/src/validation/Validation.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import {
  gradeAnswers,
  readPersisted,
  writePersisted,
  type ValidationQuestion
} from './grading';

interface Props {
  stepNumber: number;
  slug: string;
  questions: ValidationQuestion[];
}

const props = defineProps<Props>();

const answers = ref<Record<string, string>>({});
const submitted = ref(false);
const result = ref<'correct' | 'incorrect' | null>(null);

onMounted(() => {
  const persisted = readPersisted(props.slug, props.stepNumber);
  if (persisted?.correct) {
    submitted.value = true;
    result.value = 'correct';
    emitStepValidated();
  }
});

function emitStepValidated() {
  // Notify tutorial.ts that this step's validation passed.
  // Reuses the legacy contract: dispatch a 'step-validated' CustomEvent
  // on the document, with detail.stepNumber so listeners can route.
  document.dispatchEvent(new CustomEvent('step-validated', {
    detail: { stepNumber: props.stepNumber }
  }));

  // Also set the data-validated attribute on the step container —
  // legacy tutorial.ts:440-442 did this, and other CSS/JS may key off it.
  const stepEl = document.querySelector(`.tutorial-step[data-step="${props.stepNumber}"]`);
  if (stepEl) stepEl.setAttribute('data-validated', 'true');
}

function onRadioChange(qid: string, value: string) {
  answers.value[qid] = value;
}

function onTextInput(qid: string, event: Event) {
  const ce = event as CustomEvent<{ value?: string }>;
  answers.value[qid] = ce.detail?.value ?? (event.target as { value?: string } | null)?.value ?? '';
}

function onSubmit() {
  submitted.value = true;
  const { correct } = gradeAnswers(props.questions, answers.value);
  result.value = correct ? 'correct' : 'incorrect';
  if (correct) {
    writePersisted(props.slug, props.stepNumber, true);
    emitStepValidated();
  }
}

function onTryAgain() {
  // Allow re-submit on incorrect: clear submitted state, keep answers so
  // the learner can adjust without re-typing. The form re-renders below.
  submitted.value = false;
  result.value = null;
}
</script>

<template>
  <div class="validation-widget">
    <!-- Persisted-success state: skip the form entirely -->
    <ui5-message-strip
      v-if="submitted && result === 'correct'"
      design="Positive"
      hide-close-button
    >
      Correct! Well done.
    </ui5-message-strip>

    <!-- Active form -->
    <form v-else @submit.prevent="onSubmit">
      <fieldset
        v-for="(q, qi) in questions"
        :key="q.id"
        class="validation-question"
      >
        <legend>{{ q.question }}</legend>

        <template v-if="q.type === 'multiple-choice' && q.options">
          <div v-for="opt in q.options" :key="opt" class="option-row">
            <ui5-radio-button
              :name="`q-${stepNumber}-${qi}`"
              :value="opt"
              :text="opt"
              @change="onRadioChange(q.id, opt)"
            />
          </div>
        </template>

        <ui5-textarea
          v-else
          placeholder="Type your answer…"
          :rows="2"
          @input="onTextInput(q.id, $event)"
        />
      </fieldset>

      <div class="validation-actions">
        <ui5-button design="Emphasized" type="Submit">
          Submit Answer
        </ui5-button>
      </div>

      <!-- Incorrect-state strip + Try Again button.
           ui5-message-strip has no 'action' slot (verified via UI5 MCP),
           so the strip and button are rendered as siblings. -->
      <template v-if="submitted && result === 'incorrect'">
        <ui5-message-strip design="Negative" hide-close-button>
          Not quite — give it another try.
        </ui5-message-strip>
        <ui5-button
          design="Default"
          @click="onTryAgain"
          style="margin-top: 0.5rem;"
        >
          Try Again
        </ui5-button>
      </template>
    </form>
  </div>
</template>

<style scoped>
.validation-widget {
  margin: 1rem 0;
}
.validation-question {
  border: 1px solid var(--sapNeutralBorderColor, #e5e5e5);
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}
.validation-question legend {
  font-weight: 600;
  padding: 0 0.5rem;
}
.option-row {
  margin: 0.25rem 0;
}
.validation-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
}
</style>
