<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { buildStage, type SelfieStage } from './compose'

const props = defineProps<{ cutout: Blob; frameName: string; imgBase: string }>()
const emit = defineEmits<{ export: [blob: Blob]; fallback: [blob: Blob] }>()

const stageEl = ref<HTMLDivElement | null>(null)
let stage: SelfieStage | null = null

function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = URL.createObjectURL(blob)
  })
}

onMounted(async () => {
  if (!stageEl.value) return
  try {
    stage = await buildStage(stageEl.value, `${props.imgBase}/frames/${props.frameName}.png`)
    stage.addCutout(await blobToImage(props.cutout))
  } catch (e) {
    // Fail-soft: stage init failed → let the parent offer a plain download.
    console.warn('[selfie] stage init failed', e)
    emit('fallback', props.cutout)
  }
})
onBeforeUnmount(() => { try { stage?.destroy() } catch { /* noop */ } })

async function doExport() {
  if (!stage) return emit('fallback', props.cutout)
  try { emit('export', await stage.exportPng()) }
  catch { emit('fallback', props.cutout) }
}
</script>
<template>
  <div class="selfie-composer">
    <div ref="stageEl" class="selfie-stage"></div>
    <div class="selfie-editor-toolbar">
      <button type="button" class="selfie-btn" data-testid="export" @click="doExport">Export</button>
    </div>
  </div>
</template>
