<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import SaveQueryDialog from './SaveQueryDialog.vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'
import { useSavedQueries } from '../../composables/useSavedQueries'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'

const emit = defineEmits<{
  (e: 'saved'): void
}>()

const { spec } = useQuerySpec()
const { sqlNames } = useEntityGraph()
const { saveAs } = useSavedQueries()

const dialogOpen = ref(false)
const isSaving = ref(false)

const queryTitle = computed(() => spec.value?.from?.entity || '')

function openDialog() {
  if (!spec.value) return
  dialogOpen.value = true
}

function onDialogCancel() {
  dialogOpen.value = false
}

async function onDialogSave(payload: { name: string; description: string; visibility: 'private' | 'shared-admins' }) {
  if (!spec.value) return
  isSaving.value = true
  try {
    let sql = ''
    try { sql = specToSql(spec.value, sqlNames.value) } catch { /* spec invalid; sql stays empty */ }
    await saveAs({
      name: payload.name,
      description: payload.description,
      visibility: payload.visibility,
      sql,
      spec: JSON.stringify(spec.value),
    })
    dialogOpen.value = false
    emit('saved')
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[BuilderHeader] saveAs failed:', e.message)
  } finally {
    isSaving.value = false
  }
}

defineExpose({ dialogOpen, onDialogSave })
</script>

<template>
  <div class="builder-header" v-if="spec">
    <div class="title-row">
      <strong class="query-title">{{ queryTitle }}</strong>
    </div>
    <div class="actions">
      <ui5-button
        data-test="save-query"
        design="Transparent"
        icon="save"
        :disabled="!spec || isSaving"
        @click="openDialog"
      >Save query</ui5-button>
    </div>
    <SaveQueryDialog
      :open="dialogOpen"
      @save="onDialogSave"
      @cancel="onDialogCancel"
    />
  </div>
  <div v-else class="builder-header empty">
    <span class="hint">No query yet — click an entity to start.</span>
  </div>
</template>

<style scoped>
.builder-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
}
.builder-header.empty { opacity: 0.6; }
.title-row { flex: 1; }
.query-title { font-size: 0.9rem; }
.actions { display: flex; gap: 0.5rem; }
.hint { font-size: 0.8rem; color: var(--sapNeutralTextColor); }
</style>
