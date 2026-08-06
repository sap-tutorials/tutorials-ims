<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { startCamera, stopCamera, captureFrame } from './camera'

const emit = defineEmits<{ photo: [blob: Blob]; error: [message: string] }>()
const MAX = 20 * 1024 * 1024

const videoEl = ref<HTMLVideoElement | null>(null)
const cameraReady = ref(false)
let stream: MediaStream | null = null

onMounted(async () => {
  try {
    stream = await startCamera()
    if (videoEl.value) { videoEl.value.srcObject = stream; await videoEl.value.play() }
    cameraReady.value = true
  } catch {
    // Fail-soft: no camera / denied → file upload fallback renders.
    cameraReady.value = false
  }
})
onBeforeUnmount(() => { if (stream) stopCamera(stream) })

async function snap() {
  if (!videoEl.value) return
  try { emit('photo', await captureFrame(videoEl.value)) }
  catch { emit('error', 'Could not capture the photo — please try again.') }
}

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] ?? null
  if (!f) return
  if (!/^image\//.test(f.type)) return emit('error', 'Please choose an image file.')
  if (f.size > MAX) return emit('error', 'Image is too large (max 20 MB).')
  emit('photo', f)
}
</script>
<template>
  <div class="selfie-capture">
    <template v-if="cameraReady">
      <video ref="videoEl" class="selfie-video" playsinline muted aria-label="Camera preview"></video>
      <button type="button" class="selfie-btn" data-testid="snap" @click="snap">Take photo</button>
      <p class="selfie-busy">Or <label class="selfie-link">upload a photo<input type="file" accept="image/*" hidden @change="onPick" /></label> instead.</p>
    </template>
    <template v-else>
      <p class="selfie-busy">Camera unavailable — choose a photo to upload.</p>
      <input type="file" accept="image/*" aria-label="Choose a photo" @change="onPick" />
    </template>
  </div>
</template>
