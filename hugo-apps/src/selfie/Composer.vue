<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { buildStage, type SelfieStage } from './compose'

const props = defineProps<{
  rawPhoto: Blob
  cutout: Blob | null
  removeBg: boolean
  segmenting: boolean
  frameName: string
  imgBase: string
}>()
const emit = defineEmits<{
  export: [blob: Blob]
  fallback: [blob: Blob]
  'update:removeBg': [value: boolean]
  segment: []
}>()

const stageEl = ref<HTMLDivElement | null>(null)
let stage: SelfieStage | null = null

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e) }
    img.src = url
  })
}

// The blob that should currently be shown: the segmented cutout when the user
// wants the background removed and it is ready, otherwise the raw photo.
function effectiveBlob(): Blob {
  return props.removeBg && props.cutout ? props.cutout : props.rawPhoto
}

onMounted(async () => {
  if (!stageEl.value) return
  try {
    stage = await buildStage(stageEl.value, `${props.imgBase}/frames/${props.frameName}.png`)
    stage.addCutout(await blobToImage(effectiveBlob()))
  } catch (e) {
    // Fail-soft: stage init failed → let the parent offer a plain download.
    console.warn('[selfie] stage init failed', e)
    emit('fallback', effectiveBlob())
  }
})
onBeforeUnmount(() => { try { stage?.destroy() } catch { /* noop */ } })

// Live toggle: when removeBg or the cached cutout changes, swap the stage
// bitmap in place (keeps the user's drag/scale/rotate). If the user wants the
// background removed but it hasn't been computed yet, ask the parent to run it.
watch(() => [props.removeBg, props.cutout] as const, async () => {
  if (!stage) return
  if (props.removeBg && !props.cutout) {
    if (!props.segmenting) emit('segment')
    return // wait for the cutout to arrive; this watcher re-fires when it does.
  }
  try {
    stage.setImage(await blobToImage(effectiveBlob()))
  } catch (e) {
    console.warn('[selfie] image swap failed', e)
  }
})

async function doExport() {
  if (!stage) return emit('fallback', effectiveBlob())
  try { emit('export', await stage.exportPng()) }
  catch { emit('fallback', effectiveBlob()) }
}
</script>
<template>
  <div class="selfie-composer">
    <div class="selfie-stage-wrap">
      <div ref="stageEl" class="selfie-stage"></div>
      <p v-if="segmenting" class="selfie-stage-overlay" role="status">Removing the background&hellip;</p>
    </div>
    <div class="selfie-editor-toolbar">
      <label class="selfie-toggle">
        <input
          type="checkbox" :checked="removeBg" :disabled="segmenting"
          data-testid="remove-bg-compose"
          @change="emit('update:removeBg', ($event.target as HTMLInputElement).checked)"
        />
        Remove background
      </label>
      <button type="button" class="selfie-btn" data-testid="export" :disabled="segmenting" @click="doExport">Export</button>
    </div>
  </div>
</template>
