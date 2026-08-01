<script setup lang="ts">
import { ref, onMounted } from 'vue'
import type { MountConfig, MyGameboard } from './types'
const props = defineProps<{ config: MountConfig }>()
const state = ref<'player' | 'demo'>('demo')
const board = ref<MyGameboard>({ userId: '', score: 0, level: 0, avatarIndex: props.config.demoAvatar, breakdown: [] })
defineExpose({ state, board })
onMounted(async () => {
  try {
    const res = await fetch(props.config.apiMyGameboard, { headers: { accept: 'application/json' } })
    if (!res.ok) { state.value = 'demo'; return }        // 401 anonymous -> demo
    const data = await res.json()
    board.value = data; state.value = 'player'
  } catch { state.value = 'demo' }                        // fail-soft
})
</script>
<template>
  <div class="arcade-root">
    <!-- Scene added in Task 3 -->
    <div v-if="state === 'demo'" class="arcade-cta">
      <a :href="config.joinUrl" class="arcade-cta-btn">Join Devtoberfest to play</a>
    </div>
  </div>
</template>
