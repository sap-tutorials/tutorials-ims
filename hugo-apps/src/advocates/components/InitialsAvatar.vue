<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ firstName: string; lastName: string; size?: number }>();
const initials = computed(() =>
  ((props.firstName?.[0] || '') + (props.lastName?.[0] || '')).toUpperCase());
const px = computed(() => (props.size || 130) + 'px');
</script>

<template>
  <div class="adv-initials" :style="{ width: px, height: px, fontSize: 'calc(' + px + ' / 2.4)' }">
    <span>{{ initials || '·' }}</span>
  </div>
</template>

<style>
.adv-initials {
  border-radius: 50%; border: 5px solid #fff;
  background: linear-gradient(135deg,#0070f2,#6c3dff);
  color: #fff; display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; letter-spacing: -.02em;
  box-shadow: 0 14px 28px rgba(0,40,100,.22);
}
</style>
