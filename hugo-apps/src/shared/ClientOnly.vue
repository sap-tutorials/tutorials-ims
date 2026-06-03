<!--
  Renders its slot only after the component has mounted on the
  client. During SSR (renderToString), the slot is not rendered.
  This is the "<ClientOnly>" pattern from Nuxt/VitePress, written
  trivially so vanilla Vue 3 (createSSRApp) can use it without a
  framework dependency.
-->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
const mounted = ref(false)
onMounted(() => { mounted.value = true })
</script>

<template>
  <slot v-if="mounted" />
</template>
