<script setup lang="ts">
import { shareOrDownload, downloadBlob, canShareImage } from './share'

const props = defineProps<{ image: Blob }>()
const emit = defineEmits<{ restart: [] }>()
const showShare = canShareImage()
</script>
<template>
  <div class="selfie-editor-toolbar">
    <button type="button" class="selfie-btn" data-testid="download" @click="downloadBlob(props.image)">Download</button>
    <button v-if="showShare" type="button" class="selfie-btn" data-testid="share" @click="shareOrDownload(props.image)">Share</button>
    <button type="button" class="selfie-btn" data-testid="restart" @click="emit('restart')">Start over</button>
  </div>
</template>
