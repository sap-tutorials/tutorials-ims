import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// ---------------------------------------------------------------------------
// Regression guard for issue #1532 — "Regenerate explainer with AI" (and the
// sibling verb/shelf-explainer OP-header buttons) silently no-op'd. Root cause:
// the UI.DataFieldForAction annotations referenced the bound actions in the
// 'Service.Entity/action' SLASH form (e.g. 'AdminService.HomepageShelves/
// regenerate'). Fiori Elements resolves that string as an unbound *action
// import* against the OData metamodel — none exists — so FE threw "Unknown
// action import" deep inside callActionImport, swallowed the rejection, and
// never issued the bound POST. No toast, no console error: a silent failure.
//
// regenerate + markReviewed are 3-way OVERLOADED bound actions (bound
// separately to HomepageShelves, VerbDefinitions, ShelfDefinitions). The
// correct DataFieldForAction.Action string is the bare 'Service.action' form
// ('AdminService.regenerate'); ODataMetaModel returns the overload array and
// FE picks the overload whose binding-parameter type matches the object page's
// binding context. This test drives the compiled CSN the same way FE's
// metamodel resolution does: for each explainer entity's UI.Identification,
// every DataFieldForAction.Action must resolve to a bound action that actually
// exists on that entity — which the slash form provably cannot.
//
// Same bug class + fix as petoberfest approve/hide (commit 25faff53); that one
// has a live-DOM e2e guard (test/e2e/petoberfest.test.js section 0c). This is
// the compile-time equivalent so the regression is caught in unit CI without a
// deploy or admin credentials.
// ---------------------------------------------------------------------------

const EXPLAINER_ENTITIES = [
  'AdminService.HomepageShelves',
  'AdminService.VerbDefinitions',
  'AdminService.ShelfDefinitions',
];

describe('admin-annotations.cds — explainer OP-header actions resolve to bound actions (#1532)', () => {
  let csn;

  beforeAll(async () => {
    csn = await cds.load(['srv', 'app', 'db']);
  });

  for (const entityName of EXPLAINER_ENTITIES) {
    describe(entityName, () => {
      it('has a UI.Identification with DataFieldForAction entries', () => {
        const ident = csn.definitions[entityName]?.['@UI.Identification'] || [];
        const actions = ident.filter((x) => x.$Type === 'UI.DataFieldForAction');
        expect(actions.length, `${entityName} should carry OP-header action buttons`).toBeGreaterThan(0);
      });

      it('every DataFieldForAction.Action resolves to a bound action on this entity (not the slash / action-import form)', () => {
        const ent = csn.definitions[entityName];
        const ident = ent?.['@UI.Identification'] || [];
        const actionRefs = ident
          .filter((x) => x.$Type === 'UI.DataFieldForAction')
          .map((x) => x.Action);

        for (const ref of actionRefs) {
          // FE resolves the Action string via the OData metamodel. A bound
          // action is addressed by its bare service-qualified name; the local
          // action name (last segment) must be a real bound action on the
          // entity. The slash form ('AdminService.<Entity>/regenerate') has a
          // '/' — that is the exact shape FE misreads as an action import.
          expect(
            ref.includes('/'),
            `Action "${ref}" uses the Service.Entity/action slash form — FE ` +
            `resolves it as a non-existent unbound action import and throws ` +
            `"Unknown action import" (silent no-op). Use the bare ` +
            `'Service.action' form instead.`,
          ).toBe(false);

          const localName = ref.split('.').pop();
          const bound = ent.actions?.[localName];
          expect(
            bound,
            `Action "${ref}" must resolve to a bound action named "${localName}" ` +
            `on ${entityName}. Found bound actions: ` +
            `[${Object.keys(ent.actions || {}).join(', ')}]`,
          ).toBeTruthy();
          expect(bound.kind, `${localName} on ${entityName} should be an action`).toBe('action');
        }
      });
    });
  }
});
