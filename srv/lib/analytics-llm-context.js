import cds from '@sap/cds';

let _cache = null;

export function getAnalyticsContext() {
  if (_cache) return _cache;
  const isHana = cds.db && cds.db.kind === 'hana';
  const entityMap = new Map();
  const sqlNames = {};
  for (const def of Object.values(cds.model.definitions)) {
    if (def.kind !== 'entity') continue;
    if (!def['@analytics.exposed']) continue;
    if (!def.name.startsWith('com.sap.developers.ims.')) continue;
    if (/^com\.sap\.developers\.ims\.Analytics(QueryHistory|SavedQuery)$/.test(def.name)) continue;
    const projectionName = def.name.split('.').pop();
    const hanaName = def.name.replace(/\./g, '_').toUpperCase();
    const sqliteName = def.name.replace(/\./g, '_');
    const cols = new Map();
    for (const [name, elem] of Object.entries(def.elements || {})) {
      if (elem.virtual || elem.target) continue;
      cols.set(name, { type: elem.type, length: elem.length });
    }
    entityMap.set(projectionName, { columns: cols });
    sqlNames[projectionName] = isHana ? hanaName : sqliteName;
  }
  _cache = { entityMap, sqlNames };
  return _cache;
}

export function _resetAnalyticsContextForTest() { _cache = null; }
