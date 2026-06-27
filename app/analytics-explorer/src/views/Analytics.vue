<script setup lang="ts">
import '@ui5/webcomponents/dist/TabContainer.js'
import '@ui5/webcomponents/dist/Tab.js'
import '@ui5/webcomponents/dist/MessageStrip.js'
import { ref, onMounted } from 'vue'
import ExploreTab from '../components/ExploreTab.vue'
import SqlTab from '../components/SqlTab.vue'
import DashboardTab from '../components/DashboardTab.vue'
import { installChartTheme } from '../composables/useChartTheme'
import { useAuth } from '../composables/useAuth'

const { userRole } = useAuth()
const activeTab = ref('explore')
onMounted(() => installChartTheme())

function onTabSelect(e: any) {
  const key = e.detail?.tab?.dataset?.key
  if (key) activeTab.value = key
}
</script>

<template>
  <div class="analytics-view">
    <!--
      Authors get the Explore + Dashboard tabs against /author/, but the SQL
      tab is admin-only because runSelectQuery accepts arbitrary SELECTs that
      bypass projection-level restrictions. Banner explains the gap.
    -->
    <ui5-message-strip
      v-if="userRole === 'author'"
      design="Information"
      hide-close-button
      class="author-banner"
    >
      Ad-hoc SQL queries are admin-only. Contact an admin to run a SELECT
      against curated analytics tables.
    </ui5-message-strip>
    <ui5-tabcontainer @tab-select="onTabSelect">
      <ui5-tab data-key="explore" text="Explore" icon="chart-table-view" selected></ui5-tab>
      <ui5-tab v-if="userRole === 'admin'" data-key="sql" text="SQL" icon="syntax"></ui5-tab>
      <ui5-tab data-key="dashboard" text="Dashboard" icon="business-objects-experience"></ui5-tab>
    </ui5-tabcontainer>
    <div class="tab-content">
      <ExploreTab v-show="activeTab === 'explore'" />
      <SqlTab v-if="userRole === 'admin'" v-show="activeTab === 'sql'" />
      <DashboardTab v-show="activeTab === 'dashboard'" />
    </div>
  </div>
</template>

<style scoped>
.analytics-view { display: flex; flex-direction: column; height: 100%; padding: 1rem; }
.tab-content { flex: 1; margin-top: 1rem; overflow: hidden; }
.author-banner { margin-bottom: 0.75rem; }
</style>
