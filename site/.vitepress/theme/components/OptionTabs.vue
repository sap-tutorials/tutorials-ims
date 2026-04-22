<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{ tabs: string[] }>()
const activeTab = ref(0)
</script>

<template>
  <div class="option-tabs">
    <div class="fd-tabs" role="tablist">
      <div
        v-for="(tab, i) in tabs"
        :key="i"
        class="fd-tabs__item"
        :class="{ 'is-selected': activeTab === i }"
        role="tab"
        @click="activeTab = i"
      >
        <a class="fd-tabs__link">{{ tab }}</a>
      </div>
    </div>
    <div class="fd-tabs__panel">
      <template v-for="(tab, i) in tabs" :key="i">
        <div v-show="activeTab === i">
          <slot :name="`tab-${i}`" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.option-tabs {
  margin: 1rem 0;
}
.fd-tabs__item {
  cursor: pointer;
  display: inline-block;
  padding: 0.5rem 1rem;
  border-bottom: 2px solid transparent;
}
.fd-tabs__item.is-selected {
  border-bottom-color: var(--sapBrandColor, #0070f2);
}
</style>
