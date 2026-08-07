<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'
import type { MountConfig, SelfieStep } from './types'
import FramePicker from './FramePicker.vue'
import Capture from './Capture.vue'
import Composer from './Composer.vue'
import ExportBar from './ExportBar.vue'
import { removeBackground } from './segment'

defineProps<{ config: MountConfig }>()

const step = ref<SelfieStep>('capture')
const selectedFrame = ref<string | null>(null)
const cutout = ref<Blob | null>(null)
const finalImage = ref<Blob | null>(null)
const finalUrl = ref('')
const errorMsg = ref<string | null>(null)
const segmentProgress = ref(0)
const segmenting = ref(false)

async function onPhoto(blob: Blob) {
  errorMsg.value = null
  segmenting.value = true
  step.value = 'segment'
  try {
    const { blob: cut, removed } = await removeBackground(blob, (p) => { segmentProgress.value = p })
    if (!removed) errorMsg.value = 'Couldn’t remove the background — using your full photo.'
    cutout.value = cut
    step.value = 'compose'
  } finally {
    segmenting.value = false
  }
}

function setFinal(blob: Blob) {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
  finalImage.value = blob
  finalUrl.value = URL.createObjectURL(blob)
  step.value = 'export'
}

function onExport(blob: Blob) { setFinal(blob) }
function onFallback(blob: Blob) { setFinal(blob) }
function onError(msg: string) { errorMsg.value = msg }
function restart() {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
  finalUrl.value = ''
  step.value = 'capture'
  cutout.value = null
  finalImage.value = null
  errorMsg.value = null
  segmentProgress.value = 0
}

onBeforeUnmount(() => {
  if (finalUrl.value) URL.revokeObjectURL(finalUrl.value)
})
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is processed entirely on your device &mdash; it <strong>never leaves your browser</strong>.</p>

    <p v-if="errorMsg" class="selfie-error" role="alert">{{ errorMsg }}</p>

    <template v-if="step === 'capture'">
      <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
      <Capture v-if="selectedFrame" @photo="onPhoto" @error="onError" />
      <p v-else class="selfie-busy">Pick an advocate frame above to start.</p>
    </template>

    <p v-else-if="step === 'segment'" class="selfie-busy" role="status">
      Removing the background&hellip; {{ Math.round(segmentProgress * 100) }}%
    </p>

    <Composer
      v-else-if="step === 'compose' && cutout && selectedFrame"
      :cutout="cutout" :frame-name="selectedFrame" :img-base="config.imgBase"
      @export="onExport" @fallback="onFallback"
    />

    <template v-else-if="step === 'export' && finalImage">
      <img class="selfie-final" :src="finalUrl" alt="Your finished selfie" />
      <ExportBar :image="finalImage" @restart="restart" />
    </template>
  </div>
</template>
