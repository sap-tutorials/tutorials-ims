import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js'

// Shared with admin-shell so flipping dark mode in either app carries over on
// the next paint. Keep this key in sync with app/admin-shell/webapp/Component.js.
const STORAGE_KEY = 'sap-tutorials-admin-theme'

export type ThemeMode = 'auto' | 'light' | 'dark'
export type ResolvedTheme = 'sap_horizon' | 'sap_horizon_dark'

const themeMode: Ref<ThemeMode> = ref(readStoredMode())
const resolvedTheme: Ref<ResolvedTheme> = ref(resolve(themeMode.value))

// Tracks OS-level prefers-color-scheme so 'auto' mode reacts when the user
// flips their system theme without touching our switcher.
let mediaQuery: MediaQueryList | null = null
let initialized = false

function readStoredMode(): ThemeMode {
  const v = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (v === 'sap_horizon_dark') return 'dark'
  if (v === 'sap_horizon') return 'light'
  return 'auto'
}

function osPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode === 'dark') return 'sap_horizon_dark'
  if (mode === 'light') return 'sap_horizon'
  return osPrefersDark() ? 'sap_horizon_dark' : 'sap_horizon'
}

function applyResolved(theme: ResolvedTheme): void {
  resolvedTheme.value = theme
  // setTheme loads the theme bundle and restyles every UI5 web component on
  // the page. It's idempotent and safe to call repeatedly.
  setTheme(theme)
  // The chart-theme MutationObserver in useChartTheme.ts watches data-theme
  // and class, so flipping dataset.theme makes ECharts re-register and any
  // mounted instances re-init with the matching palette.
  document.documentElement.dataset.theme = theme === 'sap_horizon_dark' ? 'dark' : 'light'
}

export function initTheme(): void {
  if (initialized) return
  initialized = true
  applyResolved(resolvedTheme.value)
  if (typeof window !== 'undefined') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
      if (themeMode.value === 'auto') applyResolved(resolve('auto'))
    })
  }
}

export function setThemeMode(mode: ThemeMode): void {
  themeMode.value = mode
  if (mode === 'auto') {
    localStorage.removeItem(STORAGE_KEY)
  } else {
    localStorage.setItem(STORAGE_KEY, mode === 'dark' ? 'sap_horizon_dark' : 'sap_horizon')
  }
  applyResolved(resolve(mode))
}

export function cycleThemeMode(): void {
  const order: ThemeMode[] = ['auto', 'light', 'dark']
  const next = order[(order.indexOf(themeMode.value) + 1) % order.length]
  setThemeMode(next)
}

export function useTheme(): {
  themeMode: Ref<ThemeMode>
  resolvedTheme: Ref<ResolvedTheme>
  isDark: ComputedRef<boolean>
  setThemeMode: (mode: ThemeMode) => void
  cycleThemeMode: () => void
} {
  return {
    themeMode,
    resolvedTheme,
    isDark: computed(() => resolvedTheme.value === 'sap_horizon_dark'),
    setThemeMode,
    cycleThemeMode,
  }
}
