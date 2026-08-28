// srv/lib/feature-flags/resolve.js
// Resolves each registry descriptor into a display row for the Feature Flag
// Viewer. Delegates effective-value logic to the existing settings resolvers
// so precedence rules live in exactly one place per settings group.
import cds from '@sap/cds';
import { FEATURE_FLAGS } from './registry.js';
import { resolveKnowledgeGraphSettings } from '../runtime-config/kg-settings.js';
import { resolveUiEventsSettings } from '../runtime-config/ui-events-settings.js';
import { resolveNavigatorSettings } from '../runtime-config/navigator-settings.js';

const LOG = cds.log('feature-flags-resolver');
const NS = 'com.sap.developers.ims';

const asStr = (v) => (v === undefined || v === null ? null : String(v));

/** Read one settings singleton row (lowercase CAP keys). Null on any failure. */
async function readRow(entityName) {
  try {
    const ent = cds.entities(NS)[entityName];
    if (!ent) return null;
    return (await SELECT.one.from(ent)) ?? null;
  } catch (err) {
    LOG.warn(`${entityName} raw read failed`, err.message);
    return null;
  }
}

function envRaw(name) {
  const v = process.env[name];
  return v === undefined ? null : v;
}

/** Effective boolean for an env flag given its polarity rule. */
function envBool(raw, rule) {
  if (rule === 'true-enables') return raw === 'true';
  if (rule === 'false-disables') return raw !== 'false'; // unset or anything but 'false' → on
  return false;
}

export async function resolveFeatureFlags() {
  // Resolve the two env-layered settings groups once, and fetch the raw rows
  // once, tolerating individual failures.
  const [kgResolved, uiResolved, navResolved, kgRow, uiRow, chatRow, navRow] = await Promise.all([
    resolveKnowledgeGraphSettings().catch((e) => { LOG.warn('kg resolve failed', e.message); return null; }),
    resolveUiEventsSettings().catch((e) => { LOG.warn('uiEvents resolve failed', e.message); return null; }),
    resolveNavigatorSettings().catch((e) => { LOG.warn('navigator resolve failed', e.message); return null; }),
    readRow('KnowledgeGraphSettings'),
    readRow('UiEventsSettings'),
    readRow('ChatSettings'),
    readRow('NavigatorSettings'),
  ]);

  const resolvedByResolver = { kg: kgResolved, uiEvents: uiResolved, navigator: navResolved };
  const rowByEntity = { KnowledgeGraphSettings: kgRow, UiEventsSettings: uiRow, ChatSettings: chatRow, NavigatorSettings: navRow };

  // Pre-fetch the ImsConfig key/value rows backing any kind:'db' flags in one
  // SELECT, so the (synchronous) descriptor map below can look them up without
  // awaiting. Tolerates a read failure (→ empty map → those flags read default).
  const imsKeys = FEATURE_FLAGS.filter((f) => f.kind === 'db' && f.imsConfigKey).map((f) => f.imsConfigKey);
  const imsByKey = Object.create(null);
  if (imsKeys.length) {
    try {
      const ent = cds.entities(NS).ImsConfig;
      if (ent) {
        const rows = await SELECT.from(ent).columns('key', 'value').where({ key: { in: imsKeys } });
        for (const r of rows || []) imsByKey[r.key] = asStr(r.value);
      }
    } catch (err) {
      LOG.warn('ImsConfig db-flag read failed', err.message);
    }
  }

  return FEATURE_FLAGS.map((f) => {
    const base = {
      key: f.key, label: f.label, category: f.category, kind: f.kind,
      valueType: f.valueType, issue: f.issue || '', status: f.status,
      description: f.description, defaultValue: asStr(f.default) ?? '',
      rawDbValue: null, rawEnvValue: null,
    };
    try {
      if (f.kind === 'constant') {
        return {
          ...base, effectiveValue: asStr(f.default), enabled: Number(f.default) > 0,
          winningLayer: 'constant', howToChangeText: 'Not runtime-configurable (hardcoded).',
        };
      }

      if (f.kind === 'env') {
        const raw = envRaw(f.envVar);
        const enabled = f.envRule === 'numeric'
          ? Number(raw ?? f.default) > 0
          : envBool(raw, f.envRule);
        const effective = f.envRule === 'numeric' ? asStr(raw ?? f.default) : String(enabled);
        return {
          ...base, rawEnvValue: raw, effectiveValue: effective, enabled,
          winningLayer: raw !== null ? 'env' : 'default',
          howToChangeText: renderHowTo(f),
        };
      }

      // db (ImsConfig key/value): value is a 'true'/'false' string. No env
      // layer — DB row wins, else the descriptor default.
      if (f.kind === 'db') {
        const raw = f.imsConfigKey in imsByKey ? imsByKey[f.imsConfigKey] : null;
        const enabled = raw !== null ? String(raw).toLowerCase() === 'true' : Boolean(f.default);
        return {
          ...base, rawDbValue: raw, effectiveValue: String(enabled), enabled,
          winningLayer: raw !== null ? 'db' : 'default',
          howToChangeText: renderHowTo(f),
        };
      }

      // db-setting
      const row = rowByEntity[f.entity];
      const rawDb = row ? asStr(row[f.column]) : null;
      let enabled;
      let winningLayer;
      if (f.resolver === 'chat') {
        const dbVal = row ? row[f.column] : undefined;
        if (f.valueType === 'number') {
          // Numeric chat setting (e.g. communityRankWeight #1171): DB column
          // wins; when unset fall back to its env var, else the CDS default.
          // enabled = effective value > 0; effectiveValue is the number itself.
          const envVal = f.envVar !== undefined ? envRaw(f.envVar) : null;
          base.rawEnvValue = envVal;
          let effNum;
          if (dbVal !== undefined && dbVal !== null) { effNum = Number(dbVal); winningLayer = 'db'; }
          else if (envVal !== null) { effNum = Number(envVal); winningLayer = 'env'; }
          else { effNum = Number(f.default); winningLayer = 'default'; }
          if (!Number.isFinite(effNum) || effNum < 0) effNum = 0;
          return {
            ...base, rawDbValue: rawDb, effectiveValue: asStr(effNum), enabled: effNum > 0,
            winningLayer, howToChangeText: renderHowTo(f),
          };
        }
        // Chat booleans have no env layer: DB row wins, else CDS default.
        enabled = dbVal === undefined || dbVal === null ? Boolean(f.default) : Boolean(dbVal);
        winningLayer = dbVal === undefined || dbVal === null ? 'default' : 'db';
      } else {
        const resolved = resolvedByResolver[f.resolver];
        if (resolved == null) throw new Error(`${f.resolver} resolver unavailable`);
        enabled = Boolean(resolved[f.column]);
        // Precedence: db if row column set, else env if env var set, else default.
        const envHit = f.envVar !== undefined && envRaw(f.envVar) !== null;
        winningLayer = rawDb !== null ? 'db' : envHit ? 'env' : 'default';
        base.rawEnvValue = f.envVar !== undefined ? envRaw(f.envVar) : null;
      }
      return {
        ...base, rawDbValue: rawDb, effectiveValue: String(enabled), enabled,
        winningLayer, howToChangeText: renderHowTo(f),
      };
    } catch (err) {
      LOG.warn(`flag ${f.key} resolution failed`, err.message);
      return {
        ...base, effectiveValue: 'error', enabled: false, winningLayer: 'unknown',
        howToChangeText: renderHowTo(f),
      };
    }
  });
}

function renderHowTo(f) {
  const h = f.howToChange;
  if (!h) return 'Not runtime-configurable (hardcoded).';
  if (h.method === 'cf-env') return h.command;
  if (h.method === 'admin-tile') {
    return `Admin UI → ${h.tile} tile (${h.hash})${h.note ? ` — ${h.note}` : ''}`;
  }
  if (h.text) return h.text;
  return '';
}
