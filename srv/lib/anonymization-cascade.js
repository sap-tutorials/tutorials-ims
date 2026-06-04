import cds from '@sap/cds';

const LOG = cds.log('anonymization-cascade');

const VALID_ACTIONS = new Set([
  'null-personal',
  'delete',
  'audit-only',
  'identity-replace'
]);

let cachedPlan = null;
let cachedDefs = null;

export function _resetPlanForTest() {
  cachedPlan = null;
  cachedDefs = null;
}

/**
 * Walk model definitions, return cascade plan for every @PersonalData entity.
 * Cached on first call; the same defs object reuses the cache.
 */
export function getCascadePlan(modelDefinitions) {
  if (cachedPlan && cachedDefs === modelDefinitions) return cachedPlan;

  const plan = [];
  for (const [name, def] of Object.entries(modelDefinitions)) {
    if (def.kind !== 'entity') continue;

    // CDS CSN can store @PersonalData in two shapes:
    //   - Nested object:  def['@PersonalData'] = { EntitySemantics, cascade }  (synthetic test mocks)
    //   - Flat keys:      def['@PersonalData.EntitySemantics'], def['@PersonalData.cascade']  (real CSN from cds.load/deploy)
    // We normalise both into a single `pd` descriptor.
    const pdNested = def['@PersonalData'];
    const pdEntitySemantics = def['@PersonalData.EntitySemantics'];
    if (!pdNested && !pdEntitySemantics) continue;

    const pd = pdNested
      ? pdNested
      : { EntitySemantics: pdEntitySemantics, cascade: def['@PersonalData.cascade'] };

    plan.push(buildPlanEntry(name, def, pd));
  }

  cachedPlan = plan;
  cachedDefs = modelDefinitions;
  return plan;
}

function buildPlanEntry(name, def, pd) {
  // Resolve DataSubjectID field
  let dataSubjectField = null;
  const personalFields = [];
  for (const [fieldName, el] of Object.entries(def.elements ?? {})) {
    if (el['@PersonalData.FieldSemantics'] === 'DataSubjectID') {
      dataSubjectField = el.type === 'cds.Association' ? `${fieldName}_ID` : fieldName;
    }
    if (el['@PersonalData.IsPotentiallyPersonal']) {
      personalFields.push(fieldName);
    }
  }

  // Validate
  if (!dataSubjectField) {
    LOG.warn(`Entity ${name} has @PersonalData but no FieldSemantics: 'DataSubjectID' field — skipping cascade.`);
    return { entityName: name, action: 'skip', dataSubjectField: null, personalFields };
  }

  // Resolve action
  const requested = pd.cascade ?? 'null-personal';
  if (!VALID_ACTIONS.has(requested)) {
    LOG.warn(`Entity ${name} has unknown @PersonalData.cascade='${requested}' — skipping cascade.`);
    return { entityName: name, action: 'skip', dataSubjectField, personalFields };
  }

  return { entityName: name, action: requested, dataSubjectField, personalFields };
}

// ── Cascade action execution order ──────────────────────────────────────────
// delete + audit-only run before null-personal so that FK references are still
// intact when deleting. identity-replace runs LAST so the other actions can
// resolve the user row if needed.

const ORDER = ['delete', 'audit-only', 'null-personal', 'identity-replace'];

const ACTIONS = {
  'null-personal':    cascadeNullPersonal,
  'delete':           cascadeDelete,
  'audit-only':       cascadeAuditOnly,
  'identity-replace': cascadeIdentityReplace
};

/**
 * Execute the full anonymization cascade for the given user.
 * Walks the plan derived from cds.model.definitions and dispatches each
 * entity to its action handler in ORDER sequence.
 *
 * @param {{ ID: string, sapId: string }} user
 * @param {object} db - connected CDS database service (unused directly; CQL
 *   globals (UPDATE/DELETE/SELECT) target the connected DB automatically)
 */
export async function executeAnonymizationCascade(user, db) {
  // cds.model can be null in vitest+CDS on Windows due to ESM module-singleton
  // divergence: cds.deploy() populates cds.db.model even when the top-level
  // cds.model stays null. Fall back to cds.db.model.definitions so the
  // orchestrator works in both runtime (cds.model set) and unit-test contexts.
  const definitions = (cds.model ?? cds.db?.model)?.definitions;
  if (!definitions) throw new Error('cds.model is not available — ensure the CDS model is loaded before calling executeAnonymizationCascade');
  const plan = getCascadePlan(definitions);
  const sorted = [...plan].sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
  for (const step of sorted) {
    if (step.action === 'skip') continue;
    await ACTIONS[step.action](user, step, db);
  }
}

async function cascadeNullPersonal(user, step, _db) {
  const update = { [step.dataSubjectField]: null };
  for (const f of step.personalFields) update[f] = null;
  await UPDATE.entity(step.entityName).where({ [step.dataSubjectField]: user.ID }).set(update);
}

async function cascadeDelete(user, step, _db) {
  await DELETE.from(step.entityName).where({ [step.dataSubjectField]: user.ID });
}

async function cascadeAuditOnly(user, step, _db) {
  await UPDATE.entity(step.entityName)
    .where({ [step.dataSubjectField]: user.ID })
    .set({ createdBy: 'ANONYMIZED', modifiedBy: 'ANONYMIZED' });
}

async function cascadeIdentityReplace(user, step, _db) {
  const { buildAnonymizationOps } = await import('./anonymization.js');
  const ops = buildAnonymizationOps(user);
  await UPDATE.entity(step.entityName, user.ID).set(ops.userUpdate);
}

