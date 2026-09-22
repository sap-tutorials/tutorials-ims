// srv/lib/semaphore-sync/mapper.js
//
// Pure transformation: an SES (Semantic Enhancement Server) `allterms.json`
// response → rows ready for the tag upsert engine (srv/lib/tag-import/applier.js).
//
// SES allterms shape (see docs.progress.com .../ses-api/allterms.html):
//   { parameters:{...}, total:"N", terms:[ { term:{ name, id, classes:[...],
//     paths:[{ name, path:[...] }], metadata:{...} } }, ... ] }
// Some SES deployments flatten the wrapper (element IS the term). We accept both.
//
// Output row (consumed by applier.apply with the extended field set):
//   { semaphoreId, label, name, titlePath, isActualTag, isInterestItem }
//   - semaphoreId : term.id (stable natural key for upsert)
//   - label       : term.name verbatim (display form, e.g. "SAP S/4HANA")
//   - name        : normalized/lower-cased label (matches legacy IMS_TAG.name)
//   - titlePath   : human hierarchical path ("Software Product : SAP S/4HANA").
//                   Downstream titlePathToMdFormat() splits on ':' or '/', so we
//                   emit that human form — NOT the pre-slugged mdFormat.
//   - isActualTag / isInterestItem : derived from term.classes via opts.
//
// ⚠️ VERIFY-AGAINST-REAL-PAYLOAD: the exact `paths` element shape and the class
// URIs/names that denote "actual tag" vs "interest item" are not knowable until
// we can call the live SAPCore model with a Service Account (issue #2184). The
// class→flag mapping is therefore config-driven (opts.actualTagClasses /
// opts.interestItemClasses); run the job in dry-run mode against real data and
// tune these before flipping the feature flag on. Defaults are deliberately
// conservative: every synced term is an actual tag, none an interest item.

const PATH_SEP = ' : ';

// Case-insensitive membership test tolerant of full class URIs vs short names.
// A term class "http://sap/schema#IndustryCluster" matches config entry
// "IndustryCluster" or the full URI.
function classMatches(termClasses, wanted) {
  if (!Array.isArray(termClasses) || termClasses.length === 0) return false;
  if (!Array.isArray(wanted) || wanted.length === 0) return false;
  const wantedLc = wanted.map((w) => String(w).toLowerCase());
  return termClasses.some((c) => {
    const cl = String(c ?? '').toLowerCase();
    const short = cl.includes('#') ? cl.slice(cl.lastIndexOf('#') + 1)
      : cl.includes('/') ? cl.slice(cl.lastIndexOf('/') + 1)
      : cl;
    return wantedLc.some((w) => w === cl || w === short);
  });
}

// Normalize a display label to the legacy IMS_TAG.name form: lower-cased, with
// path/slash separators reduced to spaces and runs of whitespace collapsed.
// e.g. "SAP S/4HANA" → "sap s 4hana".
export function normalizeName(label) {
  return String(label ?? '')
    .toLowerCase()
    .replace(/[/:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Classes that are structural scaffolding in the SES hierarchy, not real
// taxonomy ancestors — dropped from the human titlePath. Verified against the
// live SAPCore payload (#2184): every path begins with a "Concept Scheme" root
// ("SAP Core Model") and a "SCHEMA" node ("Topic", "Materials Flat List", …)
// before the actual term ancestors.
const SCAFFOLD_CLASSES = new Set(['concept scheme', 'schema']);

function nodeIsScaffold(node) {
  const classes = node?.classes;
  if (!Array.isArray(classes)) return false;
  return classes.some((c) => SCAFFOLD_CLASSES.has(String(c).toLowerCase()));
}

// Extract the ordered ancestor→leaf segment names for a term. Defensive across
// the SES `paths` variants:
//   - Live SAPCore shape: paths[i].path[j] = { field: { name, classes, id } }
//   - Doc/legacy variants: paths[i].path[j] = { name } | "string"
// Structural scaffold nodes (Concept Scheme / SCHEMA) are skipped. Falls back to
// the term's own name when no usable path is present.
function deriveSegments(term) {
  const paths = Array.isArray(term.paths) ? term.paths : [];
  for (const p of paths) {
    const nodes = Array.isArray(p?.path) ? p.path : Array.isArray(p) ? p : null;
    if (!nodes) continue;
    const names = nodes
      // Unwrap the { field: {...} } envelope used by live SES; tolerate bare
      // node objects and plain strings.
      .map((n) => (n && typeof n === 'object' && n.field ? n.field : n))
      .filter((n) => !nodeIsScaffold(n))
      .map((n) => (typeof n === 'string' ? n : n?.name))
      .map((n) => (n == null ? '' : String(n).trim()))
      .filter(Boolean);
    if (names.length) return names;
  }
  return [];
}

// Build the human titlePath: ancestor segments joined by " : ", with the term's
// own display name guaranteed to be the last segment.
export function deriveTitlePath(term) {
  const label = String(term.name ?? '').trim();
  const segments = deriveSegments(term);
  if (segments.length === 0) return label;
  if (label && segments[segments.length - 1].toLowerCase() !== label.toLowerCase()) {
    segments.push(label);
  }
  return segments.join(PATH_SEP);
}

// Unwrap the `{ term: {...} }` envelope when present.
function unwrap(el) {
  if (el && typeof el === 'object' && el.term && typeof el.term === 'object') return el.term;
  return el;
}

/**
 * Map a parsed SES allterms response to upsert-ready tag rows.
 *
 * @param {object} data  Parsed allterms JSON ({ terms:[...] }).
 * @param {object} [opts]
 * @param {string[]} [opts.actualTagClasses]     class names/URIs → isActualTag=true
 * @param {string[]} [opts.interestItemClasses]  class names/URIs → isInterestItem=true
 * @param {boolean}  [opts.defaultIsActualTag=true]  isActualTag when no class config matches
 * @returns {{ rows: Array, skipped: Array }}
 */
export function mapAllTerms(data, opts = {}) {
  const {
    actualTagClasses = [],
    interestItemClasses = [],
    defaultIsActualTag = true,
  } = opts;

  const terms = Array.isArray(data?.terms) ? data.terms : [];
  const rows = [];
  const skipped = [];
  const bySemaphoreId = new Map();

  for (const el of terms) {
    const term = unwrap(el);
    if (!term || typeof term !== 'object') {
      skipped.push({ reason: 'not-an-object', raw: el });
      continue;
    }
    const semaphoreId = term.id == null ? '' : String(term.id).trim();
    const label = String(term.name ?? '').trim();
    if (!semaphoreId) {
      skipped.push({ reason: 'missing-id', raw: term });
      continue;
    }
    if (!label) {
      skipped.push({ reason: 'missing-name', raw: term });
      continue;
    }

    const isInterestItem = classMatches(term.classes, interestItemClasses);
    const isActualTag = actualTagClasses.length
      ? classMatches(term.classes, actualTagClasses)
      : defaultIsActualTag;

    const row = {
      semaphoreId,
      label,
      name: normalizeName(label),
      titlePath: deriveTitlePath(term),
      isActualTag,
      isInterestItem,
      // Raw SES classes, carried through for the applier's Tier-2 intake gate
      // and the dry-run class histogram (job). Not persisted to Tags.
      classes: Array.isArray(term.classes) ? term.classes.map(String) : [],
    };

    // De-dupe on semaphoreId (last write wins) — SES should be unique but be safe.
    if (bySemaphoreId.has(semaphoreId)) {
      rows[bySemaphoreId.get(semaphoreId)] = row;
    } else {
      bySemaphoreId.set(semaphoreId, rows.length);
      rows.push(row);
    }
  }

  return { rows, skipped };
}
