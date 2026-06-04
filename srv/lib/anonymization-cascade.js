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
    const pd = def['@PersonalData'];
    if (!pd) continue;

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
