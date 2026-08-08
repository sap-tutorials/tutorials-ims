<script setup lang="ts">
import { ref } from 'vue'
import { shareOrDownload, downloadBlob, canShareImage, copyImage, openSocialShare } from './share'

const props = defineProps<{ image: Blob }>()
const emit = defineEmits<{ restart: [] }>()
const nativeShare = canShareImage()
const copyState = ref<'idle' | 'copied' | 'unavailable'>('idle')

async function onCopy() {
  copyState.value = (await copyImage(props.image)) === 'copied' ? 'copied' : 'unavailable'
  setTimeout(() => { copyState.value = 'idle' }, 2000)
}
</script>
<template>
  <div class="selfie-editor-toolbar">
    <!-- Mobile: native share sheet (unchanged) -->
    <button
      v-if="nativeShare" type="button" class="selfie-btn" data-testid="share"
      @click="shareOrDownload(props.image)"
    >Share</button>

    <!-- Desktop: explicit row -->
    <template v-else>
      <button type="button" class="selfie-btn" data-testid="download" @click="downloadBlob(props.image)">Download</button>
      <button type="button" class="selfie-btn" data-testid="copy" @click="onCopy">
        {{ copyState === 'copied' ? 'Copied!' : copyState === 'unavailable' ? 'Copy failed' : 'Copy image' }}
      </button>
      <button type="button" class="selfie-btn" data-testid="share-x" @click="openSocialShare(props.image, 'x')">Share on X</button>
      <button type="button" class="selfie-btn" data-testid="share-linkedin" @click="openSocialShare(props.image, 'linkedin')">Share on LinkedIn</button>
    </template>

    <button type="button" class="selfie-btn" data-testid="restart" @click="emit('restart')">Start over</button>
  </div>
</template>
