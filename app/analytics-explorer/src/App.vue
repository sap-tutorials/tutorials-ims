<script setup lang="ts">
import { computed } from 'vue'
import '@ui5/webcomponents-fiori/dist/ShellBar.js'
import '@ui5/webcomponents-fiori/dist/ShellBarItem.js'
import '@ui5/webcomponents/dist/Avatar.js'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Title.js'
import '@ui5/webcomponents/dist/Popover.js'
import '@ui5/webcomponents/dist/List.js'
import '@ui5/webcomponents/dist/ListItemStandard.js'
import { useTheme, type ThemeMode } from './composables/useTheme'

const { themeMode, cycleThemeMode, setThemeMode } = useTheme()

// Single shellbar slot toggling between three modes keeps the bar compact.
// The icon and tooltip reflect the active mode so the user can read state at
// a glance — unlike admin-shell's three-position SegmentedButton, but
// functionally equivalent.
const themeIcon = computed(() => {
  if (themeMode.value === 'dark') return 'dark-mode'
  if (themeMode.value === 'light') return 'lightbulb'
  return 'sys-monitor'
})

const themeTooltip = computed(() => {
  if (themeMode.value === 'dark') return 'Theme: Dark (click for Auto)'
  if (themeMode.value === 'light') return 'Theme: Light (click for Dark)'
  return 'Theme: Auto / OS (click for Light)'
})

function onThemeClick() {
  cycleThemeMode()
}

// Pop-up menu lets users jump straight to a mode instead of cycling. Wired
// through ui5-popover anchored on the avatar so it doesn't crowd the bar.
function onProfileClick(e: Event) {
  const popover = document.getElementById('analyticsProfilePopover') as any
  if (!popover) return
  popover.opener = e.target as HTMLElement
  popover.open = true
}

function onModeSelect(e: any) {
  const mode = e.detail?.selectedItems?.[0]?.dataset?.mode as ThemeMode | undefined
  if (!mode) return
  setThemeMode(mode)
  const popover = document.getElementById('analyticsProfilePopover') as any
  if (popover) popover.open = false
}

// Stubs — wired through to admin-shell endpoints once they exist outside
// SAPUI5. Keeping no-op handlers so the shellbar layout matches admin-shell
// visually and the buttons can be filled in incrementally.
function onJouleClick() { /* TODO: open Joule chat */ }
function onHelpClick() { /* TODO: help center */ }
function onNotificationsClick() { /* TODO: notifications popover */ }
</script>

<template>
  <div class="app-shell">
    <ui5-shellbar primary-title="Analytics Explorer" secondary-title="SAP Tutorials">
      <ui5-shellbar-item
        :icon="themeIcon"
        :text="themeTooltip"
        @click="onThemeClick" />
      <ui5-shellbar-item
        icon="da"
        text="Joule"
        @click="onJouleClick" />
      <ui5-shellbar-item
        icon="sys-help"
        text="Help"
        @click="onHelpClick" />
      <ui5-shellbar-item
        icon="bell"
        text="Notifications"
        @click="onNotificationsClick" />
      <ui5-avatar
        slot="profile"
        size="XS"
        shape="Circle"
        icon="person-placeholder"
        color-scheme="Accent6"
        @click="onProfileClick" />
    </ui5-shellbar>

    <ui5-popover id="analyticsProfilePopover" placement="Bottom" header-text="Theme">
      <ui5-list selection-mode="Single" @selection-change="onModeSelect">
        <ui5-li
          icon="sys-monitor"
          text="Auto (OS)"
          data-mode="auto"
          :selected="themeMode === 'auto'" />
        <ui5-li
          icon="lightbulb"
          text="Light"
          data-mode="light"
          :selected="themeMode === 'light'" />
        <ui5-li
          icon="dark-mode"
          text="Dark"
          data-mode="dark"
          :selected="themeMode === 'dark'" />
      </ui5-list>
    </ui5-popover>

    <main class="content">
      <router-view />
    </main>
  </div>
</template>

<style scoped>
.app-shell { display: flex; flex-direction: column; height: 100vh; }
.content { flex: 1; overflow: hidden; background: var(--sapBackgroundColor); }
</style>
