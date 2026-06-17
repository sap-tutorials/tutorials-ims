<script setup lang="ts">
defineProps<{ filtersActive: boolean }>();
defineEmits<{ (e: 'reset'): void }>();
</script>

<template>
  <div class="adv-empty">
    <ui5-illustrated-message
      :name="filtersActive ? 'NoSearchResults' : 'NoData'"
      :title-text="filtersActive ? 'No advocates match your filters' : 'No advocates published yet.'"
      :subtitle-text="filtersActive ? 'Try clearing one or more filters.' : ''">
      <ui5-button v-if="filtersActive" design="Emphasized" slot="action" @click="$emit('reset')">
        Clear filters
      </ui5-button>
    </ui5-illustrated-message>
  </div>
</template>

<style>
.adv-empty { padding: 60px 24px; display: flex; justify-content: center; }
</style>
