<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import '@ui5/webcomponents-fiori/dist/ShellBar.js'
import '@ui5/webcomponents-fiori/dist/ShellBarItem.js'
import '@ui5/webcomponents/dist/Avatar.js'
import '@ui5/webcomponents/dist/Button.js'
import '@ui5/webcomponents/dist/Title.js'
import '@ui5/webcomponents/dist/Popover.js'
import '@ui5/webcomponents/dist/List.js'
import '@ui5/webcomponents/dist/ListItemStandard.js'
import { useTheme, type ThemeMode } from './composables/useTheme'
import JoulePanel from './components/joule/JoulePanel.vue'
import { useQuerySpec } from './composables/useQuerySpec'
import { useAuth } from './composables/useAuth'

const { themeMode, cycleThemeMode, setThemeMode } = useTheme()

// Shared singleton — Analytics.vue + the API modules read the same role state.
// We call load() here on mount; subsequent useAuth() consumers (already-mounted
// or lazily-mounted) see `loaded.value` flip and reactively re-evaluate.
const { user, userRole, loaded, load } = useAuth()

const userInitials = computed(() => {
  const u = user.value
  if (!u?.authenticated) return ''
  const first = (u.givenName || '')[0] || ''
  const last = (u.familyName || '')[0] || ''
  const combined = (first + last).toUpperCase()
  if (combined) return combined
  return (u.id || '')[0]?.toUpperCase() || ''
})

const userName = computed(() => {
  const u = user.value
  if (!u?.authenticated) return ''
  return [u.givenName, u.familyName].filter(Boolean).join(' ') || u.id || ''
})

const userEmail = computed(() => user.value?.email || '')

onMounted(() => { load() })

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

function onProfileClick(e: Event) {
  const popover = document.getElementById('analyticsProfilePopover') as any
  if (!popover) return
  popover.opener = e.target as HTMLElement
  popover.open = true
}

function onModeSelect(e: any) {
  const item = e.detail?.selectedItems?.[0]
  if (!item) return
  if (item.dataset?.action === 'logout') {
    window.location.href = '/logout'
    return
  }
  const mode = item.dataset?.mode as ThemeMode | undefined
  if (!mode) return
  setThemeMode(mode)
  const popover = document.getElementById('analyticsProfilePopover') as any
  if (popover) popover.open = false
}

// Joule right-rail panel — persistent, persisted via localStorage so it
// stays open across reloads if the admin had it open.
const STORAGE_KEY = 'analytics.joule.open'
const panelOpen = ref(typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1')
const querySpec = useQuerySpec()

function onJouleClick() { panelOpen.value = !panelOpen.value }
function onJouleClose() { panelOpen.value = false }
function onViewInBuilder(spec: any) {
  // useQuerySpec is a module-level singleton — setSpec flows through to SqlTab.
  querySpec.setSpec(spec)
}
watch(panelOpen, v => { try { localStorage.setItem(STORAGE_KEY, v ? '1' : '0') } catch { /* ignore */ } })

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
        v-if="userRole === 'admin'"
        icon="da"
        text="Joule"
        data-test="shellbar-joule"
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
        :initials="userInitials"
        fallback-icon="person-placeholder"
        color-scheme="Accent6"
        @click="onProfileClick" />
    </ui5-shellbar>

    <ui5-popover id="analyticsProfilePopover" placement="Bottom" :header-text="userName || 'Profile'">
      <div v-if="userName || userEmail" class="profile-block">
        <div v-if="userName" class="profile-name">{{ userName }}</div>
        <div v-if="userEmail" class="profile-email">{{ userEmail }}</div>
      </div>
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
        <ui5-li
          v-if="user?.authenticated"
          icon="log"
          text="Sign out"
          data-action="logout" />
      </ui5-list>
    </ui5-popover>

    <main class="content">
      <div class="content-col">
        <!--
          Wait for /auth/user before rendering routes — otherwise the entity
          browser fires a request against /admin/analytics/ before we know
          whether to flip to /author/, and the author would see a 403 flash.
        -->
        <div v-if="!loaded" class="auth-loading">Loading…</div>
        <div v-else-if="userRole === 'anonymous'" class="no-access">
          <a href="/admin-ui/#/noAccess">No access — request Tutorial.Author scope.</a>
        </div>
        <router-view v-else />
      </div>
      <JoulePanel
        v-if="panelOpen && userRole === 'admin'"
        @close="onJouleClose"
        @view-in-builder="onViewInBuilder"
      />
    </main>
  </div>
</template>

<style scoped>
.app-shell { display: flex; flex-direction: column; height: 100vh; }
.content { flex: 1; overflow: hidden; background: var(--sapBackgroundColor); display: flex; }
.content-col { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.profile-block {
  padding: 0.75rem 1rem 0.5rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
}
.profile-name { font-weight: 600; color: var(--sapTextColor); }
.profile-email { font-size: 0.875rem; color: var(--sapContent_LabelColor); margin-top: 0.125rem; }
.auth-loading {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor);
}
.no-access {
  padding: 2rem;
  text-align: center;
}
.no-access a {
  color: var(--sapLinkColor);
  text-decoration: none;
  font-size: 1rem;
}
.no-access a:hover { text-decoration: underline; }
</style>
