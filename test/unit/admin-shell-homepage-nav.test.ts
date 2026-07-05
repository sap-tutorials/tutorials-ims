// Text-grep test for the admin-shell wiring that surfaces Homepage Shelves,
// Redirects, and Config (issue #734). The admin-shell is UI5 and has no
// OPA / unit-test harness in this repo, so we pin structural invariants
// across the three modified files. Same approach as the explore-layout
// text-pin in #744.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SHELL_DIR = path.resolve(import.meta.dirname, '../../app/admin-shell/webapp')

describe('admin-shell homepage nav surfaces Shelves + Redirects + Config (#734)', () => {
  describe('navigation.json', () => {
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))

    it('has a top-level "homepageGroup" group with the expected children in the right order', () => {
      const group = nav.groups.find((g: any) => g.key === 'homepageGroup')
      expect(group, 'homepageGroup must exist at top level').toBeTruthy()
      // Order matters: Shelves first, then the two explainer apps (#759),
      // then For-you candidates (#763), then Redirects and Config. Any reorder
      // here is a UI regression.
      expect(group.items.map((i: any) => i.key)).toEqual([
        'homepageShelves', 'verbDefinitions', 'shelfDefinitions',
        'forYou',
        'homepageRedirects', 'homepageConfig',
      ])
    })

    it('homepageGroup has a home icon and the Homepage title', () => {
      const group = nav.groups.find((g: any) => g.key === 'homepageGroup')
      expect(group.icon).toBe('sap-icon://home')
      expect(group.title).toBe('Homepage')
    })

    it('drops the legacy single "homepage" nav-key from anywhere in the tree', () => {
      const allKeys = nav.groups.flatMap(
        (g: any) => [g.key, ...(g.items || []).map((i: any) => i.key)]
      )
      expect(allKeys).not.toContain('homepage')
    })
  })

  describe('manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))
    const routes = manifest['sap.ui5'].routing.routes

    it('has three homepage* routes — and only three', () => {
      const homepageRoutes = routes.filter((r: any) => r.name.startsWith('homepage'))
      expect(homepageRoutes.map((r: any) => r.name).sort()).toEqual([
        'homepageConfig', 'homepageRedirects', 'homepageShelves',
      ])
    })

    it('all three homepage routes target homepageTarget with prefix "hp"', () => {
      const homepageRoutes = routes.filter((r: any) => r.name.startsWith('homepage'))
      for (const r of homepageRoutes) {
        const targets = Array.isArray(r.target) ? r.target : [r.target]
        const target = typeof targets[0] === 'string' ? { name: targets[0] } : targets[0]
        expect(target.name, `${r.name} target`).toBe('homepageTarget')
        if (target.prefix !== undefined) {
          expect(target.prefix, `${r.name} prefix`).toBe('hp')
        }
      }
    })

    it('homepageShelves keeps the legacy "homepage" URL pattern (backward compat)', () => {
      const r = routes.find((x: any) => x.name === 'homepageShelves')
      expect(r.pattern).toBe('homepage')
    })

    it('has no legacy single "homepage" route name', () => {
      expect(routes.find((r: any) => r.name === 'homepage')).toBeUndefined()
    })
  })

  describe('Shell.controller.js', () => {
    const ctrl = readFileSync(path.join(SHELL_DIR, 'controller/Shell.controller.js'), 'utf8')

    it('maps the three new nav-keys in NAV_KEY_TO_ROUTE', () => {
      expect(ctrl).toMatch(/homepageShelves:\s*"homepageShelves"/)
      expect(ctrl).toMatch(/homepageRedirects:\s*"homepageRedirects"/)
      expect(ctrl).toMatch(/homepageConfig:\s*"homepageConfig"/)
    })

    it('has titles for the three new nav-keys', () => {
      // Note: NAV_KEY_TO_TITLE uses "Homepage Shelves" / "Homepage Redirects" /
      // "Homepage Config" (used as the page-header / document title), while
      // navigation.json uses the shorter "Shelves" / "Redirects" / "Config"
      // (used as the side-nav leaf label). The divergence is intentional:
      // the parent "Homepage" group label in the nav already provides the
      // prefix context, whereas the page header stands alone.
      expect(ctrl).toMatch(/homepageShelves:\s*"Homepage Shelves"/)
      expect(ctrl).toMatch(/homepageRedirects:\s*"Homepage Redirects"/)
      expect(ctrl).toMatch(/homepageConfig:\s*"Homepage Config"/)
    })

    it('pushes the inner hash for Redirects and Config (pipelinelog/joblog precedent)', () => {
      expect(ctrl).toMatch(/setHash\("homepageRedirects&\/hp\/Redirects"\)/)
      expect(ctrl).toMatch(/setHash\("homepageConfig&\/hp\/HomepageConfig"\)/)
    })

    it('does NOT setHash for homepageShelves (defaults to inner ShelvesList route)', () => {
      // Catches a future contributor copy-paste-ing an unnecessary setHash.
      expect(ctrl).not.toMatch(/setHash\("homepageShelves/)
    })

    it('drops the legacy single "homepage" nav-key mapping', () => {
      // The new keys (homepageShelves, etc.) include "homepage" as a prefix,
      // but the legacy `homepage: "homepage"` exact mapping must be gone.
      expect(ctrl).not.toMatch(/^\s+homepage:\s+"homepage"\s*,?\s*$/m)
      expect(ctrl).not.toMatch(/^\s+homepage:\s+"Homepage"\s*,?\s*$/m)
    })
  })

  describe('cross-file consistency', () => {
    // The side-nav highlight requires `selectedNavKey` (set by
    // _onRouteMatched from the matched route name) to match a key that
    // exists somewhere in navigation.json's items. Drift between the
    // three files breaks the highlight silently — pin that the three
    // route names appearing in manifest.json all exist as nav-keys.
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))

    it('every homepage* route name has a matching nav-key in navigation.json', () => {
      const navKeys = new Set(
        nav.groups.flatMap((g: any) => [g.key, ...(g.items || []).map((i: any) => i.key)])
      )
      const homepageRoutes = manifest['sap.ui5'].routing.routes
        .filter((r: any) => r.name.startsWith('homepage'))
      for (const r of homepageRoutes) {
        expect(navKeys, `route name "${r.name}" must exist as a nav-key for the side-nav highlight to work`).toContain(r.name)
      }
    })
  })
})
