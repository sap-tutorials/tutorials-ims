<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import { useGraphData } from './composables/useGraphData'
import { useFilters } from './composables/useFilters'
import { useTelemetry, dispatchPathDrawn } from './composables/useTelemetry'
import { useSelectedNode } from './composables/useSelectedNode'
import { useViewport } from './composables/useViewport'
import ExploreHeader from './components/ExploreHeader.vue'
import ExploreGraph from './components/ExploreGraph.vue'
import NodeDetailPanel from './components/NodeDetailPanel.vue'
import MobileTypedList from './components/MobileTypedList.vue'
import { fetchPath } from './api/path'
import { parseFocusParam } from './focus-param'
import type { ExploreNode, NodeType } from './types'

// Async component — the 3D chunk (three / d3-force-3d / 3d-force-graph) only
// loads when the user first opens 3D view (load-bearing: do NOT convert to a
// static import, see task-5-brief for the bundle-size constraint).
const ThreeDGraph = defineAsyncComponent(() => import('./components/ThreeDGraph.vue'))

const { payload, hasData, error } = useGraphData()
const { enabledNodeTypes, enabledPredicates, toggleNodeType, togglePredicate, setEnabledNodeTypes, ALL_NODE_TYPES } = useFilters()
const { selectedNode, selectNode } = useSelectedNode()
const { isMobile } = useViewport()
useTelemetry({ payload })

// ---------------------------------------------------------------------------
// 2D/3D toggle
// ---------------------------------------------------------------------------

/** High-signal "spine" node types used as the default 3D filter subset. */
const THREED_DEFAULT_TYPES: NodeType[] = ['tutorial', 'mission']

/** Whether the 3D toggle is visible: flag on AND desktop-only. */
const show3dToggle = computed(() => !!payload.value?.features?.threeD && !isMobile.value)

/** True = currently showing 3D scene; false = 2D Sigma graph. */
const view3d = ref(false)

/**
 * Enter 3D mode. On the first switch, if filters are still at the all-on
 * default (detected by size equality), narrow to the default 3D subset so
 * the scene stays interactive. Does NOT auto-restore on switch-back to 2D —
 * user filter choices persist.
 */
function enter3d() {
  if (!view3d.value && enabledNodeTypes.value.size === ALL_NODE_TYPES.length) {
    setEnabledNodeTypes(THREED_DEFAULT_TYPES)
  }
  view3d.value = true
}

// Ref to the ExploreGraph component, used for ?focus= deep-link camera centering.
const graphRef = ref<InstanceType<typeof ExploreGraph> | null>(null)

// Active path overlay — null when no path is drawn. Stored as the ordered
// list of node IDs the graph already uses (t:<slug> / c:<slug>) so
// ExploreGraph can compare against the graph's edge endpoints directly.
const pathNodeIds = ref<string[] | null>(null)
// Track whether the find-path call is in-flight so the UI can show a hint
// (button state lives in ExploreHeader; we expose this for future use and
// to make the "in-flight" state observable in tests).
const pathError = ref<string | null>(null)

// Clear path overlay state when viewport mode changes so we don't
// leak stale state across desktop ↔ mobile transitions. Without this,
// a path drawn on desktop silently re-renders after a mobile detour.
watch(isMobile, () => {
  pathNodeIds.value = null
  pathError.value = null
})

// Clear path overlay on 2D↔3D view switch. ExploreGraph remounts each time
// view3d flips, so a stale pathNodeIds from a prior 2D session would
// re-highlight the old path without the user re-querying it. Same pattern
// as the isMobile watcher above.
watch(view3d, () => {
  pathNodeIds.value = null
  pathError.value = null
})

// ?focus=<slug> deep-link: when ExploreGraph emits 'graphReady' (i.e. after
// buildGraph() + forceAtlas2 layout — node x/y coordinates valid), resolve
// the slug to a node id and centre/zoom the camera on it. Using 'graphReady'
// rather than a 'hasData' watcher avoids the ordering hazard where hasData
// turns true before ExploreGraph's own watch([nodes,edges]) has run
// buildGraph(), so node coordinates would not yet exist. No-op if slug is
// absent/malformed or doesn't resolve to a node. Does NOT disturb find-path.
//
// focusDone is a one-shot guard: graphReady fires on every buildGraph() call
// (filter toggles, initial load, etc.). Without the guard the camera snaps
// back to the deep-linked node on every filter toggle, overriding the user's
// manual pan/zoom. Set to true after the first successful focus.
const focusSlug = parseFocusParam(typeof window !== 'undefined' ? window.location.search : '')
const focusDone = ref(false)

function onGraphReady() {
  if (!focusSlug || focusDone.value) return
  const id = resolveNodeId(focusSlug)
  if (id && graphRef.value) {
    focusDone.value = true
    graphRef.value.focusSingleNode(id)
  }
}

// Defeat Vue 3.5 SFC template hoisting (which breaks refs under @vue/test-utils).
const appLabel = computed(() => `explore-app-${isMobile.value ? 'mobile' : 'desktop'}`)

// Apply filters before passing to the graph. Edges keep an edge only when both
// endpoints survive the node-type filter AND the predicate itself is enabled.
const filteredNodes = computed(() => {
  if (!payload.value) return []
  return payload.value.nodes.filter(n => enabledNodeTypes.value.has(n.type))
})
const filteredEdges = computed(() => {
  if (!payload.value) return []
  const visibleNodeIds = new Set(filteredNodes.value.map(n => n.id))
  return payload.value.edges.filter(e =>
    enabledPredicates.value.has(e.p) &&
    visibleNodeIds.has(e.s) &&
    visibleNodeIds.has(e.o),
  )
})

function onNodeClick(e: { id: string; node: ExploreNode }) {
  selectNode(e.node)
}

// Map a tutorial / concept slug to the node-id the graph uses. The slug
// alone is ambiguous (tutorial 'cap-handlers' and concept 'cap-handlers'
// share a slug but have ids 't:cap-handlers' / 'c:cap-handlers'). The
// /graph/path endpoint currently returns tutorial slugs only, but we
// resolve via the loaded graph payload so we transparently support
// future endpoints that return concepts too.
function resolveNodeId(slug: string): string | null {
  if (!payload.value) return null
  // Prefer tutorial match (PATH_BETWEEN walks tutorial nodes), fall back to
  // any node with that slug.
  const tutorial = payload.value.nodes.find(n => n.type === 'tutorial' && n.slug === slug)
  if (tutorial) return tutorial.id
  const any = payload.value.nodes.find(n => n.slug === slug)
  return any?.id ?? null
}

async function onFindPath(p: { from: string; to: string }) {
  pathError.value = null
  try {
    const result = await fetchPath(p.from, p.to)
    if (!result || result.steps.length === 0) {
      pathNodeIds.value = null
      pathError.value = 'No path found between those tutorials.'
      return
    }
    // Build the path-node-id chain. Prepend the source ('from') because
    // the server-side PATH_BETWEEN returns target-side candidates only;
    // the source isn't included in the response steps.
    //
    // Dedup GLOBALLY, not just consecutive repeats: /graph/path returns a
    // ranked candidate list that can repeat a slug non-consecutively (live DEV
    // showed `abap-environment-enhance-cds-view` appearing 4× across the
    // steps). A consecutive-only guard let those duplicates survive into
    // pathNodeIds; a Set collapses them to one highlighted node (#1131).
    const ids: string[] = []
    const seen = new Set<string>()
    const pushId = (id: string | null) => {
      if (id && !seen.has(id)) {
        seen.add(id)
        ids.push(id)
      }
    }
    pushId(resolveNodeId(p.from))
    for (const step of result.steps) {
      pushId(resolveNodeId(step.slug))
    }
    if (ids.length < 2) {
      pathNodeIds.value = null
      pathError.value = 'Path returned but none of the steps are loaded in the current graph view.'
      return
    }
    pathNodeIds.value = ids
    dispatchPathDrawn({ from: p.from, to: p.to, stepCount: ids.length })
  } catch (e) {
    console.error('findPath failed', e)
    pathNodeIds.value = null
    pathError.value = 'Path query failed. Please try again.'
  }
}
</script>

<template>
  <main class="explore" :data-app-id="appLabel">
    <p v-if="error" class="explore__error">Failed to load graph: {{ error.message }}</p>
    <p v-else-if="!hasData" class="explore__empty">Loading graph…</p>
    <template v-else>
      <!-- Mobile fallback: typed list grouped by node type, no canvas/Sigma. -->
      <MobileTypedList v-if="isMobile" :nodes="payload!.nodes" />
      <!-- Desktop chrome: header + canvas + side panel. -->
      <template v-else>
        <ExploreHeader
          :allNodes="payload!.nodes"
          :enabledNodeTypes="enabledNodeTypes"
          :enabledPredicates="enabledPredicates"
          @toggleNodeType="toggleNodeType"
          @togglePredicate="togglePredicate"
          @findPath="onFindPath"
        />
        <p v-if="pathError" class="explore__path-status" role="status">{{ pathError }}</p>
        <!-- 2D/3D view toggle — only rendered when flag is on AND desktop -->
        <div v-if="show3dToggle" class="explore__viewtoggle" role="group" aria-label="Graph view">
          <button
            class="explore__viewbtn"
            :aria-pressed="!view3d"
            @click="view3d = false"
          >2D</button>
          <button
            class="explore__viewbtn"
            :aria-pressed="view3d"
            @click="enter3d"
          >3D</button>
        </div>
        <div class="explore__body">
          <div class="explore__canvas">
            <ThreeDGraph
              v-if="view3d"
              :nodes="filteredNodes"
              :edges="filteredEdges"
              @nodeClick="onNodeClick"
            />
            <ExploreGraph
              v-else
              ref="graphRef"
              :nodes="filteredNodes"
              :edges="filteredEdges"
              :path="pathNodeIds"
              @nodeClick="onNodeClick"
              @graphReady="onGraphReady"
            />
          </div>
          <NodeDetailPanel
            class="explore__side"
            :selectedNode="selectedNode"
            :edges="payload!.edges"
          />
        </div>
      </template>
    </template>
  </main>
</template>

<style>
.explore {
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.explore__body {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}
.explore__canvas {
  flex: 1;
  min-width: 0;
  position: relative;
}
.explore__side {
  width: 20%;
  min-width: 260px;
  max-width: 360px;
  flex-shrink: 0;
}
.explore__error {
  color: #b00;
  padding: 1rem;
}
.explore__empty {
  text-align: center;
  margin-top: 4rem;
  color: #666;
}
.explore__path-status {
  background: #fff7e6;
  color: #6b4500;
  border-bottom: 1px solid #f0d9a8;
  padding: 0.5rem 1rem;
  margin: 0;
  font-size: 0.9rem;
}
/* Segmented 2D/3D toggle — desktop only (show3dToggle gates rendering). */
.explore__viewtoggle {
  display: flex;
  gap: 0;
  align-self: flex-start;
  margin: 0.5rem 1rem;
  border: 1px solid #b0b0b0;
  border-radius: 4px;
  overflow: hidden;
}
.explore__viewbtn {
  padding: 0.25rem 0.75rem;
  font-size: 0.8rem;
  background: #fff;
  border: none;
  cursor: pointer;
  color: #333;
  line-height: 1.5;
}
.explore__viewbtn + .explore__viewbtn {
  border-left: 1px solid #b0b0b0;
}
.explore__viewbtn[aria-pressed="true"] {
  background: #0070f2;
  color: #fff;
  font-weight: 600;
}
</style>
