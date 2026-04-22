<script setup lang="ts">
import { ref, computed } from 'vue'

interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
  correctAnswer: string
}

const props = defineProps<{
  questions: ValidationQuestion[]
}>()

const emit = defineEmits<{
  validated: []
}>()

const answers = ref<Record<string, string>>({})
const validated = ref(false)
const validationError = ref('')
const attempts = ref(0)

const allAnswered = computed(() =>
  props.questions.every(q => answers.value[q.id]?.trim())
)

function submitValidation() {
  validationError.value = ''
  attempts.value++

  const allCorrect = props.questions.every(q => {
    const given = answers.value[q.id]?.trim() ?? ''
    if (q.type === 'multiple-choice') return given === q.correctAnswer
    return given.toLowerCase() === q.correctAnswer.toLowerCase()
  })

  if (allCorrect) {
    validated.value = true
    emit('validated')
  } else {
    validationError.value = 'Not quite right. Check your answers and try again.'
  }
}
</script>

<template>
  <div class="step-validation" v-if="!validated">
    <div class="validation-header">
      <span class="validation-icon">&#9997;</span>
      <h4>Validate your knowledge</h4>
    </div>
    <div v-for="q in questions" :key="q.id" class="validation-question">
      <p class="question-text">{{ q.question }}</p>
      <div v-if="q.type === 'multiple-choice'" class="question-options">
        <div
          v-for="opt in q.options"
          :key="opt"
          class="fd-form-item validation-option"
          :class="{ selected: answers[q.id] === opt }"
          @click="answers[q.id] = opt"
        >
          <input
            type="radio"
            class="fd-radio"
            :name="q.id"
            :value="opt"
            :id="`${q.id}-${opt}`"
            v-model="answers[q.id]"
          />
          <label class="fd-radio__label" :for="`${q.id}-${opt}`">{{ opt }}</label>
        </div>
      </div>
      <div v-else>
        <input
          type="text"
          v-model="answers[q.id]"
          class="fd-input"
          placeholder="Type your answer..."
          @keyup.enter="allAnswered && submitValidation()"
        />
      </div>
    </div>
    <div class="validation-actions">
      <button
        class="fd-button fd-button--emphasized"
        :disabled="!allAnswered"
        @click="submitValidation"
      >
        Submit Answer{{ questions.length > 1 ? 's' : '' }}
      </button>
    </div>
    <p v-if="validationError" class="validation-error">{{ validationError }}</p>
  </div>
  <div v-if="validated" class="validation-success">
    <span class="success-icon">&#10003;</span> Correct! Well done.
  </div>
</template>

<style scoped>
.step-validation {
  background: var(--sapInformationBackground, #e8f4fd);
  border: 1px solid var(--sapInformativeBorderColor, #0070f2);
  border-radius: 0.5rem;
  padding: 1.25rem;
  margin: 1.5rem 0 0;
}
.validation-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.validation-icon {
  font-size: 1.125rem;
}
.validation-header h4 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
}
.validation-question {
  margin-bottom: 1rem;
}
.question-text {
  font-weight: 500;
  margin: 0 0 0.5rem;
  color: var(--sapTextColor, #32363a);
}
.question-options {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}
.validation-option {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background 0.15s;
  font-size: 0.9375rem;
}
.validation-option:hover {
  background: var(--sapList_Hover_Background, rgba(0, 112, 242, 0.06));
}
.validation-option.selected {
  background: var(--sapList_Active_Background, rgba(0, 112, 242, 0.1));
  font-weight: 500;
}
.validation-option .fd-radio__label {
  cursor: pointer;
  font-size: 0.9375rem;
  margin: 0;
  padding: 0;
}
.validation-actions {
  margin-top: 0.75rem;
}
.validation-error {
  color: var(--sapNegativeColor, #b00);
  margin: 0.5rem 0 0;
  font-size: 0.875rem;
  font-weight: 500;
}
.validation-success {
  background: var(--sapPositiveBackground, #f1fdf4);
  border: 1px solid var(--sapPositiveColor, #107e3e);
  border-radius: 0.5rem;
  padding: 0.75rem 1rem;
  margin: 1.5rem 0 0;
  color: var(--sapPositiveTextColor, #107e3e);
  font-weight: 600;
  font-size: 0.9375rem;
}
.success-icon {
  font-size: 1rem;
}
</style>
