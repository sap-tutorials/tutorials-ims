<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useApi } from '../composables/useApi'

const props = defineProps<{
  slug: string
  stepNumber: number
}>()

const emit = defineEmits<{
  validated: []
}>()

interface ValidationQuestion {
  id: string
  question: string
  type: 'multiple-choice' | 'text'
  options?: string[]
}

const { get, post, loading, error } = useApi()
const questions = ref<ValidationQuestion[]>([])
const answers = ref<Record<string, string>>({})
const validated = ref(false)
const validationError = ref('')
const hasValidation = ref(false)

onMounted(async () => {
  const data = await get<{ questions: ValidationQuestion[] }>(
    `/tutorials/${props.slug}/steps/${props.stepNumber}/validation`
  )
  if (data && data.questions.length > 0) {
    questions.value = data.questions
    hasValidation.value = true
  }
})

async function submitValidation() {
  validationError.value = ''
  const result = await post<{ valid: boolean; message?: string }>(
    `/tutorials/${props.slug}/steps/${props.stepNumber}/validate`,
    answers.value
  )
  if (result?.valid) {
    validated.value = true
    emit('validated')
  } else {
    validationError.value = result?.message ?? 'Incorrect. Try again.'
  }
}
</script>

<template>
  <div class="step-validation" v-if="hasValidation && !validated">
    <h4>Validation</h4>
    <div v-for="q in questions" :key="q.id" class="validation-question">
      <p>{{ q.question }}</p>
      <div v-if="q.type === 'multiple-choice'">
        <label v-for="opt in q.options" :key="opt" class="validation-option">
          <input type="radio" :name="q.id" :value="opt" v-model="answers[q.id]" />
          {{ opt }}
        </label>
      </div>
      <div v-else>
        <input type="text" v-model="answers[q.id]" class="validation-text-input" />
      </div>
    </div>
    <button
      class="fd-button fd-button--positive"
      :disabled="loading"
      @click="submitValidation"
    >
      {{ loading ? 'Checking...' : 'Validate' }}
    </button>
    <p v-if="validationError" class="validation-error">{{ validationError }}</p>
  </div>
  <div v-if="validated" class="validation-success">
    <span class="fd-badge fd-badge--accent-color-8">&#10003; Validated</span>
  </div>
</template>

<style scoped>
.step-validation {
  background: var(--sapInformationBackground, #e8f0fe);
  padding: 1rem;
  border-radius: 0.5rem;
  margin: 1rem 0;
}
.validation-question {
  margin-bottom: 1rem;
}
.validation-option {
  display: block;
  padding: 0.25rem 0;
  cursor: pointer;
}
.validation-text-input {
  width: 100%;
  padding: 0.5rem;
  border: 1px solid var(--sapNeutralBorderColor, #d9d9d9);
  border-radius: 0.25rem;
}
.validation-error {
  color: var(--sapNegativeColor, #b00);
  margin-top: 0.5rem;
}
.validation-success {
  margin: 1rem 0;
}
</style>
