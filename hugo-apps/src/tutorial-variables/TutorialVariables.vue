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
    v-if="shown.length"
    class="tv"
    aria-label="Tutorial variables"
  >
    <h2 class="tv__heading">Your values</h2>
    <p class="tv__hint">
      Fill in the values below — they will be substituted throughout the tutorial.
    </p>
    <div class="tv__fields">
      <div
        v-for="v in shown"
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
import { reactive, computed, onMounted } from 'vue'
import { applyValue, resolveInitial } from './substitution'
import type { TutorialVariable } from './substitution'
import { readValue, writeValue } from './storage'

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

// [#2852] Only variables that are not explicitly hidden get a reader-facing
// input. `display` absent or true → shown; false → hidden (value still
// substitutes into the body via onMounted below).
const shown = computed(() => props.variables.filter(v => v.display !== false))

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

  // [#2852] Hidden variables are author-owned: a literal `value` is applied
  // unconditionally and is NOT read from or written to reader storage. Doing
  // this first means a stale persisted value can never shadow the author's
  // fixed value for a hidden variable.
  const hiddenNames = new Set<string>()
  for (const v of props.variables) {
    if (v.display === false) {
      hiddenNames.add(v.name)
      if (typeof v.value === 'string') {
        fieldValues[v.name] = v.value
        applyValue(v.name, v.value)
      }
    }
  }

  // Restore persisted values before fetching identity defaults — only for
  // displayed (reader-owned) variables.
  const storageCtx = { missionSlug: props.missionSlug || undefined, tutorialSlug: props.slug }
  for (const v of props.variables) {
    if (hiddenNames.has(v.name)) continue
    const stored = readValue(v.name, storageCtx)
    if (stored !== null) {
      fieldValues[v.name] = stored
      applyValue(v.name, stored)
    }
  }

  const identity = await fetchIdentity()

  for (const v of props.variables) {
    // Skip if a hidden literal value or a persisted value already populated it
    if (fieldValues[v.name]) continue

    // [#2852] Precedence: literal `value` > identity-regex `default` > empty.
    const init = resolveInitial(v, identity)
    if (init !== null) {
      fieldValues[v.name] = init
      applyValue(v.name, init)
    }
  }
})

// ──────────────────────────────────────────────────────────────────────────────
// onInput — live substitution
// ──────────────────────────────────────────────────────────────────────────────

function onInput(v: TutorialVariable, rawValue: string) {
  // I2: browsers ignore :maxlength on type="number". Enforce digit-length
  // manually: if the variable is numeric AND maxLength is set AND the entered
  // value exceeds maxLength characters, clamp it to the first maxLength chars
  // and reflect back into the field so the visual state stays consistent.
  let value = rawValue
  if (v.type === 'number' && v.maxLength !== undefined && value.length > v.maxLength) {
    value = value.slice(0, v.maxLength)
    // Reflect the clamped value back into the <input> DOM node.
    const input = document.getElementById(`tv-input-${v.name}`) as HTMLInputElement | null
    if (input) input.value = value
  }

  fieldValues[v.name] = value

  // Validation: mark required-but-empty fields
  if (v.required) {
    invalid[v.name] = value.trim() === ''
  }

  applyValue(v.name, value)

  // TASK-6: Persist the new value to localStorage.
  writeValue(v.name, value, { missionSlug: props.missionSlug || undefined, tutorialSlug: props.slug })
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
