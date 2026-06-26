<!-- hugo-apps/src/alerts/Alerts.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import type { ApiAlert } from './types';
import { severityToPriority } from './severity-priority';

const props = defineProps<{ alerts: ApiAlert[] }>();
const emit = defineEmits<{ (e: 'dismiss', id: string): void; (e: 'cta', url: string): void; }>();

const items = computed(() => props.alerts.map(a => ({
  ...a,
  priority: severityToPriority(a.severity),
})));

function onClose(id: string) { emit('dismiss', id); }
function onCta(url: string)  { emit('cta', url); }
</script>

<template>
  <div v-if="items.length === 0" class="alerts-empty">
    <ui5-illustrated-message name="NoNotifications" title-text="You're all caught up." />
  </div>
  <ui5-list v-else id="sb-alerts-list" separators="Inner" mode="None">
    <ui5-li-notification
      v-for="item in items"
      :key="item.id"
      :data-alert-id="item.id"
      :data-severity="item.severity"
      :title-text="item.title"
      :priority="item.priority"
      :show-close="item.dismissible"
      @close="onClose(item.id)"
    >
      <span v-if="item.body">{{ item.body }}</span>
      <ui5-button
        v-if="item.ctaUrl"
        slot="footnote"
        design="Transparent"
        @click="onCta(item.ctaUrl!)"
      >{{ item.ctaLabel || 'Open' }}</ui5-button>
    </ui5-li-notification>
  </ui5-list>
</template>
