<script setup lang="ts">
import { ref } from 'vue'
import type { MountConfig } from './types'
import FramePicker from './FramePicker.vue'
import Uploader from './Uploader.vue'
import Editor from './Editor.vue'
defineProps<{ config: MountConfig }>()
const selectedFrame = ref<string | null>(null)
const composite = ref<string | null>(null)
const errorMsg = ref<string | null>(null)
defineExpose({ selectedFrame, composite })

function onResult(dataUrl: string) {
  errorMsg.value = null
  composite.value = dataUrl
}
function onError(message: string) {
  errorMsg.value = message
}
function restart() {
  composite.value = null
  errorMsg.value = null
}
</script>
<template>
  <div class="selfie-root">
    <p class="selfie-note">Your photo is uploaded to build the image and is <strong>not stored</strong>.</p>

    <!-- Pick + upload (collapses once a composite comes back, as legacy did on image load) -->
    <template v-if="!composite">
      <FramePicker :frames="config.frames" :img-base="config.imgBase" @select="selectedFrame = $event" />
      <Uploader :api-upload="config.apiUpload" :selected-frame="selectedFrame" @result="onResult" @error="onError" />
    </template>

    <p v-if="errorMsg" class="selfie-error" role="alert">{{ errorMsg }}</p>

    <!-- Crop / rotate / download -->
    <Editor v-if="composite" :data-url="composite" @restart="restart" />
  </div>
</template>
