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

const total = computed(() => props.stats?.total ?? 0);
const active = computed(() => props.stats?.activeVsInactive?.active ?? 0);
const activeRatePct = computed(() =>
  total.value ? Math.round((active.value / total.value) * 100) : 0,
);
// Health signal for the active-rate headline: green ≥60%, amber ≥35%, else red.
const activeRateLevel = computed(() =>
  activeRatePct.value >= 60 ? 'good' : activeRatePct.value >= 35 ? 'warn' : 'poor',
);

// Bar width (% of the largest value in the same panel) so rows are visually comparable.
function barPct(count: number, entries: [string, number][]): number {
  const max = entries.reduce((m, [, v]) => Math.max(m, v), 0);
  return max ? Math.round((count / max) * 100) : 0;
}
// A category is "thin" when it holds under a third of the leading category's coverage.
function isThin(count: number, entries: [string, number][]): boolean {
  return barPct(count, entries) < 34;
}

// One-line narrative computed from the fields we have (no invented trend data).
const summary = computed(() => {
  if (!total.value) return '';
  const s = props.stats;
  const published = s.publishedCount ?? 0;
  const sap = s.sapVsCommunity?.sap ?? 0;
  const community = s.sapVsCommunity?.community ?? 0;
  const cats = categoryEntries.value;
  const parts = [
    `${published} of ${total.value} channels are published, and ${active.value} (${activeRatePct.value}%) are active.`,
    `${sap} are SAP-owned; ${community} are community-run.`,
  ];
  if (cats.length) {
    const strongest = cats[0];
    const thin = cats.filter(([, c]) => isThin(c, cats)).map(([name]) => name);
    parts.push(`Coverage is strongest in ${strongest[0]} (${strongest[1]}).`);
    if (thin.length) parts.push(`Thinnest coverage: ${thin.join(', ')}.`);
  }
  return parts.join(' ');
});
</script>

<template>
  <div class="channels-health">
    <p v-if="isEmpty" class="channels-health__empty">No channel data available yet.</p>
    <template v-else>
      <p class="health-narrative" data-testid="health-summary">{{ summary }}</p>

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
        <div class="health-stat" :class="`health-stat--${activeRateLevel}`" data-testid="active-rate">
          <span class="health-stat__value">{{ activeRatePct }}%</span>
          <span class="health-stat__label">Active rate</span>
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
            <span class="health-panel__bar" aria-hidden="true">
              <span class="health-panel__fill" :style="{ width: barPct(count, statusEntries) + '%' }"></span>
            </span>
            <span class="health-panel__count">{{ count }}</span>
          </li>
        </ul>
      </section>

      <!-- Category coverage -->
      <section class="health-panel">
        <h2 class="health-panel__title">By Category</h2>
        <ul class="health-panel__list">
          <li
            v-for="[category, count] in categoryEntries"
            :key="category"
            class="health-panel__row"
            :class="{ 'health-panel__row--thin': isThin(count, categoryEntries) }"
          >
            <span class="health-panel__name">
              {{ category }}
              <span v-if="isThin(count, categoryEntries)" class="health-panel__tag">thin</span>
            </span>
            <span class="health-panel__bar" aria-hidden="true">
              <span class="health-panel__fill" :style="{ width: barPct(count, categoryEntries) + '%' }"></span>
            </span>
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
            <span class="health-panel__bar" aria-hidden="true">
              <span class="health-panel__fill" :style="{ width: barPct(count, ownerTypeEntries) + '%' }"></span>
            </span>
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
.health-narrative {
  margin: 0;
  padding: 0.875rem 1.125rem;
  border-left: 3px solid var(--sapAccentColor6, #0064d9);
  background: var(--sapInfobar_Background, #f2f7fd);
  border-radius: var(--sapElement_BorderCornerRadius, 0.5rem);
  font-size: 0.9375rem;
  line-height: 1.5;
  color: var(--sapTextColor, #1d2d3e);
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
.health-stat--good .health-stat__value { color: var(--sapPositiveColor, #256f3a); }
.health-stat--warn .health-stat__value { color: var(--sapCriticalColor, #b8590a); }
.health-stat--poor .health-stat__value { color: var(--sapNegativeColor, #aa0808); }
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
  display: grid;
  grid-template-columns: minmax(7rem, 12rem) 1fr auto;
  align-items: center;
  gap: 0.75rem;
  padding: 0.3125rem 0;
  border-bottom: 1px solid var(--sapList_BorderColor, #d9d9d9);
  font-size: 0.9375rem;
}
.health-panel__row:last-child {
  border-bottom: none;
}
.health-panel__name {
  color: var(--sapTextColor, #1d2d3e);
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.health-panel__tag {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  padding: 0.05rem 0.4rem;
  border-radius: 0.5rem;
  color: var(--sapCriticalColor, #b8590a);
  background: var(--sapCriticalBackground, #fef7f1);
  border: 1px solid var(--sapCriticalBorderColor, #e76500);
}
.health-panel__bar {
  height: 0.5rem;
  border-radius: 0.25rem;
  background: var(--sapList_Background, #f5f6f7);
  overflow: hidden;
}
.health-panel__fill {
  display: block;
  height: 100%;
  border-radius: 0.25rem;
  background: var(--sapAccentColor6, #0064d9);
}
.health-panel__row--thin .health-panel__fill {
  background: var(--sapCriticalColor, #e76500);
}
.health-panel__count {
  font-weight: 600;
  color: var(--sapAccentColor6, #0064d9);
  min-width: 2.5rem;
  text-align: right;
}
.health-footer {
  font-size: 0.8125rem;
  color: var(--sapNeutralTextColor, #556b82);
  margin: 0;
}
</style>
