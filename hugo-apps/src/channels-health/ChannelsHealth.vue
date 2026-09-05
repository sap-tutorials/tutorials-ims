<script setup lang="ts">
import { computed } from 'vue';

interface ChannelsStats {
  total?: number;
  publishedCount?: number;
  byStatus?: Record<string, number>;
  byOwnerType?: Record<string, number>;
  byCategory?: Record<string, number>;
  bySubcategory?: Record<string, number>;
  sapVsCommunity?: { sap: number; community: number };
  activeVsInactive?: { active: number; inactive: number };
  buildAt?: string;
  error?: string | null;
}

const props = defineProps<{ stats: ChannelsStats }>();

const isEmpty = computed(() => !props.stats?.total);

const statusEntries = computed(() =>
  Object.entries(props.stats?.byStatus ?? {}).sort((a, b) => b[1] - a[1]),
);
const ownerTypeEntries = computed(() =>
  Object.entries(props.stats?.byOwnerType ?? {}).sort((a, b) => b[1] - a[1]),
);
const categoryEntries = computed(() =>
  Object.entries(props.stats?.byCategory ?? {}).sort((a, b) => b[1] - a[1]),
);
</script>

<template>
  <div class="channels-health">
    <p v-if="isEmpty" class="channels-health__empty">No channel data available yet.</p>
    <template v-else>
      <!-- Summary row -->
      <div class="health-summary">
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.total ?? 0 }}</span>
          <span class="health-stat__label">Total channels</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.publishedCount ?? 0 }}</span>
          <span class="health-stat__label">Published</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.activeVsInactive?.active ?? 0 }}</span>
          <span class="health-stat__label">Active</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.activeVsInactive?.inactive ?? 0 }}</span>
          <span class="health-stat__label">Inactive</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.sapVsCommunity?.sap ?? 0 }}</span>
          <span class="health-stat__label">SAP-owned</span>
        </div>
        <div class="health-stat">
          <span class="health-stat__value">{{ stats.sapVsCommunity?.community ?? 0 }}</span>
          <span class="health-stat__label">Community</span>
        </div>
      </div>

      <!-- Status breakdown -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Status</h2>
        <ul class="health-panel__list">
          <li v-for="[status, count] in statusEntries" :key="status" class="health-panel__row">
            <span class="health-panel__name">{{ status }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <!-- Category coverage -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Category</h2>
        <ul class="health-panel__list">
          <li v-for="[category, count] in categoryEntries" :key="category" class="health-panel__row">
            <span class="health-panel__name">{{ category }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <!-- Owner type breakdown -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Owner Type</h2>
        <ul class="health-panel__list">
          <li v-for="[ownerType, count] in ownerTypeEntries" :key="ownerType" class="health-panel__row">
            <span class="health-panel__name">{{ ownerType.replace(/_/g, ' ') }}</span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <p v-if="stats.buildAt" class="health-footer">
        Stats as of {{ new Date(stats.buildAt).toLocaleDateString() }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.channels-health {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.channels-health__empty {
  color: var(--sapNeutralTextColor, #556b82);
}
.health-summary {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
  gap: 0.75rem;
}
.health-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.875rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.health-stat__value {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--sapAccentColor6, #0064d9);
}
.health-stat__label {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
  text-align: center;
}
.health-panel {
  padding: 1rem 1.25rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.health-panel__title {
  margin: 0 0 0.75rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--sapGroup_TitleTextColor, #1d2d3e);
}
.health-panel__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}
.health-panel__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0;
  border-bottom: 1px solid var(--sapList_BorderColor, #d9d9d9);
  font-size: 0.9375rem;
}
.health-panel__row:last-child {
  border-bottom: none;
}
.health-panel__name {
  color: var(--sapTextColor, #1d2d3e);
}
.health-panel__count {
  font-weight: 600;
  color: var(--sapAccentColor6, #0064d9);
}
.health-footer {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
  margin: 0;
}
</style>
