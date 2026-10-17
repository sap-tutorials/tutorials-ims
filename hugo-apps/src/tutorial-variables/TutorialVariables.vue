<!--
  TutorialVariables.vue
  Tutorial-variables island: renders a labelled input per variable, pre-fills
  from the authenticated user's identity, and does live substitution of every
  [data-tut-var="NAME"] span on the page as the reader types.

  Task-6 seam: a `writeValue(slug, name, value)` call should be inserted
  at the comment marked "TASK-6 SEAM" below. Task 6 will modify onInput to
  add localStorage persistence and mission carry-over; this component stays
  otherwise unchanged.
-->
<template>
  <section
    v-if="variables.length"
    class="tv"
    aria-label="Tutorial variables"
  >
    <h2 class="tv__heading">Your values</h2>
    <p class="tv__hint">
      Fill in the values below — they will be substituted throughout the tutorial.
    </p>
    <div class="tv__fields">
      <div
        v-for="v in variables"
        :key="v.name"
        class="tv__field"
      >
        <label :for="`tv-input-${v.name}`" class="tv__label">
          {{ v.label }}
          <span v-if="v.required" class="tv__required" aria-label="required">*</span>
        </label>
        <input
          :id="`tv-input-${v.name}`"
          :value="fieldValues[v.name]"
          :type="v.type === 'number' ? 'number' : 'text'"
          :maxlength="v.maxLength ?? undefined"
          :required="v.required ?? false"
          :placeholder="v.placeholder ?? ''"
          :aria-required="v.required ? 'true' : undefined"
          :class="['tv__input', { 'tv__input--invalid': invalid[v.name] }]"
          autocomplete="off"
          @input="onInput(v, ($event.target as HTMLInputElement).value)"
        />
        <span
          v-if="invalid[v.name]"
          class="tv__error"
          role="alert"
        >Required</span>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { reactive, onMounted } from 'vue'
import { applyValue, resolveDefault } from './substitution'
import type { TutorialVariable } from './substitution'

// ──────────────────────────────────────────────────────────────────────────────
// Props
// ──────────────────────────────────────────────────────────────────────────────

const props = defineProps<{
  variables: TutorialVariable[]
  slug: string
  missionSlug: string
}>()

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────

const fieldValues = reactive<Record<string, string>>({})
const invalid = reactive<Record<string, boolean>>({})

// ──────────────────────────────────────────────────────────────────────────────
// Identity fetch — /auth/user, credentials:'include'
// Any failure (network, 401, anon) → identity stays null; defaults silently skipped.
// ──────────────────────────────────────────────────────────────────────────────

async function fetchIdentity(): Promise<Record<string, string> | null> {
  try {
    const r = await fetch('/auth/user', { credentials: 'include' })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// onMounted — seed initial values from identity defaults
// ──────────────────────────────────────────────────────────────────────────────

onMounted(async () => {
  // Initialise all fields to empty string so they're reactive from the start
  for (const v of props.variables) {
    fieldValues[v.name] = ''
    invalid[v.name] = false
  }

  // TASK-6 SEAM: Task 6 will insert a readValue(slug, name) call here to
  // restore persisted values before falling back to the identity default.
  // Expected shape:
  //   const stored = readValue(props.slug, v.name)
  //   if (stored !== null) { fieldValues[v.name] = stored; applyValue(v.name, stored); continue; }

  const identity = await fetchIdentity()

  for (const v of props.variables) {
    // Skip if Task 6 has already populated this field from storage
    if (fieldValues[v.name]) continue

    const def = resolveDefault(v, identity)
    if (def !== null) {
      fieldValues[v.name] = def
      applyValue(v.name, def)
    }
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// onInput — live substitution
// ──────────────────────────────────────────────────────────────────────────────

function onInput(v: TutorialVariable, value: string) {
  fieldValues[v.name] = value

  // Validation: mark required-but-empty fields
  if (v.required) {
    invalid[v.name] = value.trim() === ''
  }

  applyValue(v.name, value)

  // TASK-6 SEAM: Task 6 inserts here:
  //   writeValue(props.slug, v.name, value)
}
</script>

<style scoped>
.tv {
  margin: 0 0 1.5rem;
  padding: 1.25rem 1.5rem;
  background: var(--sapList_Background, var(--sapBackgroundColor, #fff));
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: 0.5rem;
}

.tv__heading {
  margin: 0 0 0.25rem;
  font-size: 1.0625rem;
  font-weight: 600;
  color: var(--sapTextColor, #1d2d3e);
}

.tv__hint {
  margin: 0 0 1rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #556b82);
}

.tv__fields {
  display: flex;
  flex-direction: column;
  gap: 0.875rem;
}

.tv__field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.tv__label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--sapContent_LabelColor, #556b82);
}

.tv__required {
  color: var(--sapNegativeColor, #b00);
  margin-left: 0.2em;
}

.tv__input {
  padding: 0.4375rem 0.625rem;
  font: inherit;
  font-size: 0.9375rem;
  color: var(--sapField_TextColor, var(--sapTextColor, #1d2d3e));
  background: var(--sapField_Background, #fff);
  border: 1px solid var(--sapField_BorderColor, #bfc2c5);
  border-radius: 0.25rem;
  box-sizing: border-box;
  width: 100%;
  max-width: 28rem;
}

.tv__input:focus {
  outline: none;
  border-color: var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
  box-shadow: 0 0 0 1px var(--sapField_Focus_BorderColor, var(--sapBrandColor, #0070f2));
}

.tv__input--invalid {
  border-color: var(--sapNegativeColor, #b00);
}

.tv__input--invalid:focus {
  border-color: var(--sapNegativeColor, #b00);
  box-shadow: 0 0 0 1px var(--sapNegativeColor, #b00);
}

.tv__error {
  font-size: 0.8125rem;
  color: var(--sapNegativeColor, #b00);
}
</style>
