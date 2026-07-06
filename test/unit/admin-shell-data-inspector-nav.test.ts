// Structural pins for the Data Inspector wireup (#999). The admin-shell is
// UI5 and has no OPA / unit-test harness in this repo, so we grep the
// files that together surface the plugin's UI:
//
//   1. navigation.json           — external nav entry under System, Admin-gated
//   2. approuter/xs-app.json     — UI + OData routes with Admin scope
//   3. mta.yaml + .deploy/mta.yaml — copy the plugin's webapp into approuter static
//
// Same shape as admin-shell-homepage-nav.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const NAV_JSON = path.join(REPO_ROOT, 'app/admin-shell/webapp/model/navigation.json')
const XS_APP = path.join(REPO_ROOT, 'approuter/xs-app.json')
const MTA_ROOT = path.join(REPO_ROOT, 'mta.yaml')
const MTA_DEPLOY = path.join(REPO_ROOT, '.deploy/mta.yaml')

describe('admin-shell Data Inspector wiring (#999)', () => {
  describe('navigation.json', () => {
    const nav = JSON.parse(readFileSync(NAV_JSON, 'utf8'))
    const system = nav.groups.find((g: any) => g.key === 'system')

    it('has a "dataInspector" entry under the System group', () => {
      expect(system, 'System group must exist').toBeTruthy()
      const entry = system.items.find((i: any) => i.key === 'dataInspector')
      expect(entry, 'System group must include a dataInspector nav entry').toBeTruthy()
    })

    it('opens the approuter-mounted /data-inspector-ui/ path in the current tab', () => {
      const entry = system.items.find((i: any) => i.key === 'dataInspector')
      // href + target: "_self" mirrors the analyticsExternal precedent —
      // the browser navigates to a top-level SPA that shares XSUAA session
      // with the admin shell.
      expect(entry.href).toBe('/data-inspector-ui/')
      expect(entry.target).toBe('_self')
    })

    it('is admin-gated', () => {
      // Data Inspector exposes raw DB rows across every entity in every
      // service. Authors must not see the nav entry.
      const entry = system.items.find((i: any) => i.key === 'dataInspector')
      expect(entry.requiredScope).toBe('Admin')
    })
  })

  describe('approuter/xs-app.json', () => {
    const xsApp = JSON.parse(readFileSync(XS_APP, 'utf8'))
    const routes = xsApp.routes as any[]
    const uiRoute = routes.find(r => r.source === '^/data-inspector-ui/(.*)$')
    const odataRoute = routes.find(r => r.source === '^/odata/v4/data-inspector/(.*)$')

    it('static-serves /data-inspector-ui/* with Admin scope', () => {
      expect(uiRoute, 'UI route must exist').toBeTruthy()
      expect(uiRoute.localDir).toBe('static')
      expect(uiRoute.authenticationType).toBe('xsuaa')
      expect(uiRoute.scope).toBe('$XSAPPNAME.Admin')
    })

    it('forwards /odata/v4/data-inspector/* to srv-api with Admin scope', () => {
      expect(odataRoute, 'OData route must exist').toBeTruthy()
      expect(odataRoute.destination).toBe('srv-api')
      expect(odataRoute.authenticationType).toBe('xsuaa')
      expect(odataRoute.scope).toBe('$XSAPPNAME.Admin')
    })

    it('places both routes BEFORE the anonymous catch-all', () => {
      // The catch-all `^(.*)$` serves static with authenticationType: none.
      // Both data-inspector routes must come first so XSUAA gating actually
      // applies — else the UI is anonymously reachable at /data-inspector-ui/.
      const catchAllIdx = routes.findIndex(r => r.source === '^(.*)$')
      expect(catchAllIdx).toBeGreaterThan(-1)
      expect(routes.indexOf(uiRoute)).toBeLessThan(catchAllIdx)
      expect(routes.indexOf(odataRoute)).toBeLessThan(catchAllIdx)
    })
  })

  describe('mta build recipes copy the plugin webapp', () => {
    // Both MTA variants (canonical local at .deploy/mta.yaml, root mta.yaml
    // for CI/deploy.yml) must copy node_modules/@cap-js/data-inspector's
    // webapp into approuter static, and rewrite the UI5 CDN to match CSP.
    for (const [label, mtaPath] of [
      ['.deploy/mta.yaml', MTA_DEPLOY],
      ['mta.yaml',         MTA_ROOT],
    ] as const) {
      describe(label, () => {
        const mta = readFileSync(mtaPath, 'utf8')

        it('copies the plugin webapp into approuter static/data-inspector-ui/', () => {
          expect(mta).toMatch(/cp -r [^\n]*node_modules\/@cap-js\/data-inspector\/app\/data-inspector-ui\/webapp\//)
        })

        it('rewrites the SAPUI5 CDN to ui5.sap.com (matches approuter CSP)', () => {
          expect(mta).toMatch(/sapui5\.hana\.ondemand\.com[^\n]*ui5\.sap\.com/)
        })
      })
    }
  })

  describe('package.json — runtime dep placement', () => {
    // @cap-js/data-inspector registers DataInspectorService at plugin-load
    // time (cds-plugin.js) which mounts /odata/v4/data-inspector/. CF's
    // nodejs_buildpack runs `npm install` with NODE_ENV=production, which
    // skips devDependencies. If the plugin sits in devDependencies, the srv
    // container has no plugin at boot → OData 404 → Fiori UI loads its
    // index.html from the approuter but can't reach mainService and the
    // user sees an approuter/UI 404. Keep it in dependencies.
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))

    it('lives in dependencies, not devDependencies', () => {
      expect(pkg.dependencies?.['@cap-js/data-inspector']).toBeTruthy()
      expect(pkg.devDependencies?.['@cap-js/data-inspector']).toBeUndefined()
    })
  })
})
