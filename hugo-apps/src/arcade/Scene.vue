<script setup lang="ts">
import { computed } from 'vue'
import type { MyGameboard, MountConfig } from './types'
import { sceneMap, avatarFile } from './scene-map'
const props = defineProps<{ board: MyGameboard; config: MountConfig; demo: boolean }>()
const place = computed(() => sceneMap(props.board.level))
const avatar = computed(() => avatarFile(props.config.imgBase, props.board.avatarIndex))
const img = (p: string) => `${props.config.imgBase}/${p}`
</script>
<template>
  <div class="scene" :class="{ 'scene-demo': demo }">
    <img class="s-frame"  :src="img('arcade/BackgroundOKG.png')" alt="Arcade cabinet" />
    <img class="s-bezel"  :src="img('arcade/okBottom.png')" alt="" loading="lazy" />
    <img class="s-title"  :src="img('arcade/Group_13.png')" alt="Devtoberfest Gameboard" loading="lazy" />
    <img class="s-sky"    :src="img('arcade/clouds/Group_12a.png')" alt="" loading="lazy" />
    <!-- 4 level clouds/waypoints -->
    <div v-for="n in 4" :key="n" class="s-cloud" :class="`cloud-${n}`"></div>
    <!-- ambient sprites (animated GIFs / drifting sprites) -->
    <img class="s-lobster drift-x" :src="img('arcade/clouds/Group8.png')" alt="" loading="lazy" />
    <img class="s-alien   drift-y" :src="img('arcade/clouds/Group10.png')" alt="" loading="lazy" />
    <img class="s-runner"          :src="img('arcade/clouds/Runner.gif')" alt="" loading="lazy" />
    <img class="s-logo"            :src="img('arcade/devtoberfest_square_small.gif')" alt="Devtoberfest" loading="lazy" />
    <img class="s-sap"             :src="img('arcade/sap.svg')" alt="SAP" loading="lazy" />
    <!-- HUD -->
    <div class="s-banner">POINTS: {{ board.score }} LEVEL: {{ board.level }}</div>
    <!-- the player avatar on its level cloud -->
    <img class="s-avatar" :class="[`cloud-${place.cloud}`, place.bounceClass]" :src="avatar" :alt="`Your avatar, level ${board.level}`" />
    <span v-for="h in place.hearts" :key="h" class="s-heart heart">&#9829;</span>
    <div class="s-led led-green"></div>
  </div>
</template>
