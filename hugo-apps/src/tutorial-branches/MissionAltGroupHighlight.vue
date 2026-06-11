<!-- hugo-apps/src/tutorial-branches/MissionAltGroupHighlight.vue -->
<!--
  Issue #172 PR 3 — mission side-nav alt-group recommendation highlight.
  Pure side-effect component: fetches /build/mission/<slug>, finds altGroup
  items with a recommendation, marks the matching <ui5-side-navigation-sub-item>
  with data-recommended="true" so PR 2's CSS bolds the chip.
-->
<template></template>
<script setup lang="ts">
import { onMounted, getCurrentInstance } from 'vue';

interface MissionItem {
  type: 'tutorial' | 'altGroup';
  groupKey?: string;
  recommendation?: { picked: string };
}

onMounted(async () => {
  const inst = getCurrentInstance();
  const root = inst?.proxy?.$el?.parentElement as HTMLElement | null;
  const navRoot = root?.closest('[data-mission-nav]') as HTMLElement | null;
  const missionSlug = navRoot?.dataset.missionSlug;
  if (!missionSlug) return;

  try {
    const res = await fetch(`/build/mission/${encodeURIComponent(missionSlug)}`, {
      credentials: 'include',
    });
    if (!res.ok) return;
    const data = await res.json();
    for (const item of (data.items ?? []) as MissionItem[]) {
      if (item.type !== 'altGroup' || !item.recommendation) continue;
      const sel = `[data-altgroup-key="${CSS.escape(item.groupKey ?? '')}"][data-altgroup-branch-key="${CSS.escape(item.recommendation.picked)}"]`;
      const recommendedItem = navRoot?.querySelector<HTMLElement>(sel);
      if (recommendedItem) recommendedItem.setAttribute('data-recommended', 'true');
    }
  } catch {
    // Silent — degraded mode is acceptable.
  }
});
</script>
