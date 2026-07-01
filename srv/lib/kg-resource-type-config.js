// srv/lib/kg-resource-type-config.js
//
// Single source of truth for external-resource type metadata: icon, singular
// and plural labels, priority order, and renderMeta (server-side meta-text
// string composition per row).
//
// Consumed by:
//   - srv/knowledge-graph-service.js — both the neighborhood and (future)
//     neighborhoodFull handlers stamp each row with metaText via renderMeta
//     and ship the array (minus renderMeta) as typeConfig on the response.
//   - hugo-apps (indirectly) — Vue components read typeConfig from the wire
//     to render icons + section labels without any v-if r.type === '...' chain.
//
// Priorities are SPARSE (10, 20, 30, ...) so a future type can slot between
// existing ones without a mass renumber. Adding a new external type =
// one new entry here + one corpus loader in the CAP handler.
//
// Meta-text shapes mirror hugo-apps/src/related-graph/RelatedGraph.vue
// lines 145-197 byte-for-byte — the sidebar today already emits these
// strings via v-if branches; this module hoists that logic to the server
// so the client stays type-agnostic.

import {
  formatDate,
  formatLevel,
  formatRelativeMonth,
} from './kg-meta-formatters.js';

// Shared tail expression for every renderMeta that composes a segment list.
// Empty parts → '' (no orphan ' · ' delimiter); non-empty → leading ' · '
// plus segments joined by ' · '. api-doc uses a different shape (unconditional
// "Official reference" lead) and does NOT use this helper.
const joinMeta = (parts) => (parts.length ? ' · ' + parts.join(' · ') : '');

export const RESOURCE_TYPE_CONFIG = [
  {
    type: 'learning-journey',
    icon: '🎓',
    singular: 'Learning journey',
    plural: 'Learning journeys',
    priority: 10,
    metaTemplate: 'Level · Duration',
    renderMeta(r) {
      const row = r || {};
      const parts = [];
      if (row.level) {
        const s = formatLevel(row.level);
        if (s) parts.push(s);
      }
      if (row.durationHours != null) parts.push(`${row.durationHours}h`);
      return joinMeta(parts);
    },
  },
  {
    type: 'blog-post',
    icon: '📝',
    singular: 'Blog post',
    plural: 'Blog posts',
    priority: 20,
    metaTemplate: 'Author · Date',
    renderMeta(r) {
      const row = r || {};
      const parts = [];
      if (row.authorName) parts.push(`by ${row.authorName}`);
      if (row.postedAt) {
        const d = formatDate(row.postedAt);
        if (d) parts.push(d);
      }
      return joinMeta(parts);
    },
  },
  {
    type: 'discovery-mission',
    icon: '🔍',
    singular: 'Discovery mission',
    plural: 'Discovery missions',
    priority: 30,
    metaTemplate: 'Effort · Category',
    renderMeta(r) {
      const row = r || {};
      const parts = [];
      if (row.effortLevel != null) parts.push(`effort ${row.effortLevel}`);
      if (row.categoryLabel) parts.push(row.categoryLabel);
      return joinMeta(parts);
    },
  },
  {
    type: 'video',
    icon: '▶️',
    singular: 'Video',
    plural: 'Videos',
    priority: 40,
    metaTemplate: 'Channel · Date',
    renderMeta(r) {
      const row = r || {};
      const parts = [];
      if (row.channelTitle) parts.push(`by ${row.channelTitle}`);
      if (row.publishedAt) {
        const d = formatDate(row.publishedAt);
        if (d) parts.push(d);
      }
      return joinMeta(parts);
    },
  },
  {
    type: 'api-doc',
    icon: '📖',
    singular: 'API reference',
    plural: 'API references',
    priority: 50,
    metaTemplate: 'Official reference · Category',
    renderMeta(r) {
      // "Official reference" lead is UNCONDITIONAL — every api.sap.com row
      // is an official reference by construction. Category is optional.
      // apiType is deliberately NOT rendered in metaText (see spec §4.5) —
      // the concept page shows the apiType badge separately.
      const row = r || {};
      let out = ' · Official reference';
      if (row.category) out += ` · ${row.category}`;
      return out;
    },
  },
  {
    type: 'sample',
    icon: '🧪',
    singular: 'Sample',
    plural: 'Samples',
    priority: 60,
    metaTemplate: 'Language · Stars · Last commit month',
    renderMeta(r) {
      const row = r || {};
      const parts = [];
      if (row.language) parts.push(row.language);
      if (row.stars != null) parts.push(`${row.stars} stars`);
      if (row.lastCommitAt) {
        const m = formatRelativeMonth(row.lastCommitAt);
        if (m) parts.push(`Updated ${m}`);
      }
      return joinMeta(parts);
    },
  },
  {
    type: 'help-doc',
    icon: '📚',
    singular: 'Help doc',
    plural: 'Help docs',
    priority: 70,
    metaTemplate: 'Source · Anchor',
    renderMeta(r) {
      // Phase 4.7 (#748): sourceLabel is precomputed at payload time from a
      // constant map (cap-cloud-sap → 'CAP', help-sap-com → 'SAP Help',
      // ui5-sap-com → 'UI5'). anchorLabel is a title-cased anchor slug.
      const row = r || {};
      const parts = [];
      if (row.sourceLabel) parts.push(row.sourceLabel);
      if (row.anchorLabel) parts.push(row.anchorLabel);
      return joinMeta(parts);
    },
  },
];
