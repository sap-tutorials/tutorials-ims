// Structural pins for the Personal Access Tokens nav wireup (#1105 follow-up).
// The admin-shell is UI5 with no OPA harness in this repo, so we grep the
// files that together surface the tile. Same shape as
// admin-shell-homepage-nav.test.ts and admin-shell-data-inspector-nav.test.ts.
//
// Root cause this pins against: "pats" was added to navigation.json, the
// manifest route/target, the patsComponent usage, and annotations — but NOT
// to Shell.controller.js's NAV_KEY_TO_ROUTE map. onNavItemSelect looks up
// NAV_KEY_TO_ROUTE[key]; a miss makes the `if (sRoute)` guard skip navTo, so
// clicking the sidebar entry silently no-ops: no URL change, no error, no
// network call — the panel never opens. Identical trap to #763 (forYou).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SHELL_DIR = path.resolve(import.meta.dirname, '../../app/admin-shell/webapp')

describe('admin-shell Personal Access Tokens nav wiring (#1105)', () => {
  describe('navigation.json', () => {
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))

    it('has a "pats" entry under the Account group', () => {
      const group = nav.groups.find((g: any) => g.key === 'account')
      expect(group, 'Account group must exist').toBeTruthy()
      const entry = group.items.find((i: any) => i.key === 'pats')
      expect(entry, 'Account group must include a pats nav entry').toBeTruthy()
      expect(entry.title).toBe('Personal Access Tokens')
    })
  })

  describe('Shell.controller.js', () => {
    const ctrl = readFileSync(path.join(SHELL_DIR, 'controller/Shell.controller.js'), 'utf8')

    // The bug: without these two entries, onNavItemSelect silently no-ops
    // (NAV_KEY_TO_ROUTE["pats"] is undefined → the `if (sRoute)` guard skips
    // navTo). Same failure mode called out in the #763 forYou test comment.
    it('maps the pats nav-key in NAV_KEY_TO_ROUTE', () => {
      expect(ctrl).toMatch(/pats:\s*"pats"/)
    })

    it('maps the pats nav-key in NAV_KEY_TO_TITLE', () => {
      expect(ctrl).toMatch(/pats:\s*"Personal Access Tokens"/)
    })
  })

  describe('manifest.json', () => {
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))
    const routes = manifest['sap.ui5'].routing.routes

    it('has a pats route wired to patsTarget', () => {
      const r = routes.find((x: any) => x.name === 'pats')
      expect(r, 'pats route must exist').toBeTruthy()
      const targets = Array.isArray(r.target) ? r.target : [r.target]
      const target = typeof targets[0] === 'string' ? { name: targets[0] } : targets[0]
      expect(target.name).toBe('patsTarget')
    })
  })

  // General guard against the whole rot class (the reason this bug shipped):
  // every INTERNAL nav-key — one backed by a manifest route rather than an
  // external `href` — MUST appear in NAV_KEY_TO_ROUTE, or its sidebar click
  // silently no-ops. External-link entries (href + target, e.g. analytics
  // and dataInspector) are intentionally NOT routed and are excluded.
  describe('cross-file consistency — no unrouted internal nav-keys', () => {
    const nav = JSON.parse(readFileSync(path.join(SHELL_DIR, 'model/navigation.json'), 'utf8'))
    const ctrl = readFileSync(path.join(SHELL_DIR, 'controller/Shell.controller.js'), 'utf8')
    const manifest = JSON.parse(readFileSync(path.join(SHELL_DIR, 'manifest.json'), 'utf8'))

    const routeNames = new Set(manifest['sap.ui5'].routing.routes.map((r: any) => r.name))

    // Flatten every leaf nav entry (group leaves + nested items).
    const leaves: any[] = []
    for (const g of nav.groups) {
      if (g.items) g.items.forEach((i: any) => leaves.push(i))
      else leaves.push(g)
    }

    it('every internal (non-href) nav-key is present in NAV_KEY_TO_ROUTE', () => {
      const unrouted = leaves
        .filter((e) => e.key && !e.href && routeNames.has(e.key))
        // Match `<key>:` as a NAV_KEY_TO_ROUTE property key.
        .filter((e) => !new RegExp(`\\b${e.key}:\\s*"`).test(ctrl))
        .map((e) => e.key)
      expect(
        unrouted,
        `these nav-keys have a manifest route but are missing from NAV_KEY_TO_ROUTE, so their sidebar click silently no-ops: ${unrouted.join(', ')}`
      ).toEqual([])
    })
  })
})
