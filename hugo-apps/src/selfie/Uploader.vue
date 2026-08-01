<script setup lang="ts">
import { ref, computed } from 'vue'
import { uploadSelfie } from './upload'

const props = defineProps<{ apiUpload: string; selectedFrame: string | null }>()
const emit = defineEmits<{ result: [dataUrl: string]; error: [message: string] }>()

const file = ref<File | null>(null)
const busy = ref(false)

const canUpload = computed(() => !!props.selectedFrame && !!file.value && !busy.value)

function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  file.value = input.files && input.files[0] ? input.files[0] : null
}

async function submit() {
  if (!props.selectedFrame || !file.value) return
  busy.value = true
  try {
    const dataUrl = await uploadSelfie(props.apiUpload, file.value, props.selectedFrame)
    emit('result', dataUrl)
  } catch (e) {
    // Fail-soft: the error banner is owned solely by the parent (Selfie.vue),
    // which renders a single .selfie-error from this emitted message.
    const msg = e instanceof Error ? e.message : 'Something went wrong — please try again.'
    emit('error', msg)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="selfie-uploader">
    <input
      type="file"
      accept="image/*"
      aria-label="Choose a photo"
      :disabled="!selectedFrame || busy"
      @change="onPick"
    />
    <button type="button" class="selfie-btn" :disabled="!canUpload" @click="submit">
      {{ busy ? 'Building…' : 'Create selfie' }}
    </button>
    <span v-if="busy" class="selfie-busy" role="status">Uploading your photo…</span>
  </div>
  <p v-if="!selectedFrame" class="selfie-busy">Pick an advocate frame above to enable upload.</p>
</template>
