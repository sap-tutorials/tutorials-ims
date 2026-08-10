<script setup lang="ts">
/**
 * hugo-apps/src/topics-map/App.vue
 *
 * Orchestrator for the Topics Cluster Map island.
 * Fetches /graph/clusters-data, passes the super-graph to ClusterMap.vue.
 * On fetch failure the container is hidden (progressive enhancement — the
 * baked gallery above still renders).
 */
import { ref, onMounted } from 'vue';
import ClusterMap from './ClusterMap.vue';

const props = defineProps<{
  focusCluster: string;
}>();

interface ClusterNode {
  id: string;
  type: 'cluster';
  slug: string;
  label: string;
  size: number;
}

interface ClusterEdge {
  s: string;
  o: string;
  weight: number;
}

interface ClustersData {
  nodes: ClusterNode[];
  edges: ClusterEdge[];
  generatedAt?: string;
}

const graphData = ref<ClustersData | null>(null);
const failed = ref(false);

onMounted(async () => {
  try {
    const res = await fetch('/graph/clusters-data');
    if (!res.ok) {
      failed.value = true;
      return;
    }
    const data: ClustersData = await res.json();
    graphData.value = data;
  } catch {
    // Network error — degrade silently; the baked gallery stays visible.
    failed.value = true;
  }
});
</script>

<template>
  <!-- Hide entire island on fetch failure; baked gallery above remains. -->
  <div v-if="!failed && graphData" class="topics-map-island">
    <ClusterMap
      :nodes="graphData.nodes"
      :edges="graphData.edges"
      :focus-cluster="focusCluster"
    />
  </div>
</template>
