import { ref, computed } from 'vue'

// Module-level state — singleton across consumers. All composables that need
// to know the active user (App shell, Analytics view, API modules) share one
// load() round-trip and one reactive `userRole`. Anonymous browsers hitting
// /analytics-ui/ directly (no XSUAA scope) get `loaded=true` + role='anonymous'.
type AuthUser = {
  authenticated: boolean
  id: string
  isAdmin?: boolean
  isAuthor?: boolean
  email?: string
  givenName?: string
  familyName?: string
}

const user = ref<AuthUser | null>(null)
const loaded = ref(false)
let inflight: Promise<void> | null = null

export type UserRole = 'admin' | 'author' | 'anonymous'

export function useAuth() {
  async function load(): Promise<void> {
    if (loaded.value) return
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const res = await fetch('/auth/user', { credentials: 'include' })
        user.value = res.ok ? await res.json() : null
      } catch {
        user.value = null
      } finally {
        loaded.value = true
        inflight = null
      }
    })()
    return inflight
  }

  const userRole = computed<UserRole>(() => {
    if (!user.value || !user.value.authenticated) return 'anonymous'
    if (user.value.isAdmin) return 'admin'
    if (user.value.isAuthor) return 'author'
    return 'anonymous'
  })

  // Authors hit the curated /author/ surface (see srv/author-service.cds);
  // admins keep the full /admin/analytics/ playground. The path always carries
  // its trailing slash so callers can append `EntityName` or `function()`.
  const servicePath = computed<string>(() =>
    userRole.value === 'author' ? '/author/' : '/admin/analytics/'
  )

  return { user, userRole, servicePath, loaded, load }
}
