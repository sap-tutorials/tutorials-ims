'use strict';
// Shared contract for the BTP→BAIP homepage audit scripts.
// Single source of truth for which entities/fields are audited and how
// they map onto HANA table/column names.

const NS = 'com.sap.developers.ims';

// Bare field map (entity → key + audited text fields). Order of textFields
// is intentional (matches spec); do not reorder.
const RAW = [
  { entity: 'HomepageShelves',          keyField: 'ID',
    textFields: ['title', 'description', 'tagline', 'whyItMatters'] },
  { entity: 'VerbDefinitions',          keyField: 'verbKey',
    textFields: ['label', 'tagline', 'whyItMatters'] },
  { entity: 'ShelfDefinitions',         keyField: 'shelfKey',
    textFields: ['label', 'tagline', 'whyItMatters'] },
  { entity: 'HomepageForYouCandidates', keyField: 'ID',
    textFields: ['title', 'description'] },
  { entity: 'HomepageFeaturedTopics',   keyField: 'ID',
    textFields: ['displayTitle', 'notes'] },
];

// HANA stores unquoted-declared identifiers upper-cased; table name is the
// namespace + entity, dots→underscores, upper-cased.
const hanaTableFor = (entity) =>
  `${NS}.${entity}`.replace(/\./g, '_').toUpperCase();

const AUDIT_MAP = RAW.map(m => ({
  ...m,
  hanaTable: hanaTableFor(m.entity),
  hanaKeyCol: m.keyField.toUpperCase(),
}));

const candidateRe = () => /btp|business technology platform/i;
const CANDIDATE_RE = /btp|business technology platform/i;

const isCandidate = (value) =>
  typeof value === 'string' && CANDIDATE_RE.test(value);

module.exports = { NS, AUDIT_MAP, candidateRe, CANDIDATE_RE, isCandidate };
