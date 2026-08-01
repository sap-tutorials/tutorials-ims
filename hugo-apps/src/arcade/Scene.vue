<script setup lang="ts">
import { computed } from 'vue'
import type { MyGameboard, MountConfig } from './types'
import { sceneMap, avatarFile } from './scene-map'
import SoundToggle from './SoundToggle.vue'
import { howToPlay, lawyersHappy, menuItems, pointsBanner, gameboardHeader } from './scene-text'
const props = defineProps<{ board: MyGameboard; config: MountConfig; demo: boolean }>()
const place = computed(() => sceneMap(props.board.level))
const avatar = computed(() => avatarFile(props.config.imgBase, props.board.avatarIndex))
const img = (p: string) => `${props.config.imgBase}/${p}`
const firstName = computed(() => props.board.firstName || 'Player')
const banner = computed(() => pointsBanner(props.board.score, props.board.level))
const header = computed(() => gameboardHeader(firstName.value))
const communityUrl = computed(() => props.board.communityUrl || null)
</script>
<template>
  <div class="scene" :class="{ 'scene-demo': demo }">
    <img class="s-frame"  :src="img('arcade/BackgroundOKG.png')" alt="Arcade cabinet" />
    <img class="s-bezel"  :src="img('arcade/okBottom.png')" alt="" loading="lazy" />
    <img class="s-title"  :src="img('arcade/Group_13.png')" alt="Devtoberfest Gameboard" loading="lazy" />
    <img class="s-sky"    :src="img('arcade/clouds/Group_12a.png')" alt="" loading="lazy" />

    <!-- Gameboard greeting header + SAP Community profile link (link only when community-linked). -->
    <div class="s-header">
      <span>{{ header }}</span>
      <a v-if="communityUrl" :href="communityUrl" target="_blank" rel="noopener">SAP Community Profile</a>
    </div>

    <!-- 4 level clouds/waypoints -->
    <div v-for="n in 4" :key="n" class="s-cloud" :class="`cloud-${n}`"></div>
    <!-- ambient sprites (animated GIFs / drifting sprites) -->
    <img class="s-lobster drift-x" :src="img('arcade/clouds/Group8.png')" alt="" loading="lazy" />
    <img class="s-alien   drift-y" :src="img('arcade/clouds/Group10.png')" alt="" loading="lazy" />
    <img class="s-runner"          :src="img('arcade/clouds/Runner.gif')" alt="" loading="lazy" />
    <img class="s-logo"            :src="img('arcade/devtoberfest_square_small.gif')" alt="Devtoberfest" loading="lazy" />
    <img class="s-sap"             :src="img('arcade/sap.svg')" alt="SAP" loading="lazy" />

    <!-- HOW TO PLAY column (left) -->
    <div class="s-column s-howto">
      <h2 class="s-column-head">{{ howToPlay.heading }}</h2>
      <p class="s-column-body">
        {{ howToPlay.intro }}
        <a :href="howToPlay.joinLinkUrl" target="_blank" rel="noopener">{{ howToPlay.joinLinkLabel }}</a>.
        {{ howToPlay.body }}
        <a :href="howToPlay.hereUrl" target="_blank" rel="noopener">{{ howToPlay.hereLabel }}</a>
      </p>
    </div>

    <!-- MAKING THE LAWYERS HAPPY column (right) -->
    <div class="s-column s-lawyers">
      <h2 class="s-column-head">{{ lawyersHappy.heading }}</h2>
      <p class="s-column-body">
        {{ lawyersHappy.body }}
        <a :href="lawyersHappy.hereUrl" target="_blank" rel="noopener">{{ lawyersHappy.hereLabel }}</a>
      </p>
    </div>

    <!-- Menu icons (top-right): Awards / Points / Rules → rules blog; Sound = toggle. -->
    <nav class="s-menu" aria-label="Devtoberfest menu">
      <a v-for="m in menuItems" :key="m.label" :href="m.href" target="_blank" rel="noopener" :title="m.label">{{ m.label }}</a>
      <SoundToggle :img-base="config.imgBase" />
    </nav>

    <!-- HUD -->
    <div class="s-banner">{{ banner }}</div>
    <!-- the player avatar on its level cloud -->
    <img class="s-avatar" :class="[`cloud-${place.cloud}`, place.bounceClass]" :src="avatar" :alt="`Your avatar, level ${board.level}`" />
    <span v-for="h in place.hearts" :key="h" class="s-heart heart">&#9829;</span>
    <div class="s-led led-green"></div>
  </div>
</template>
