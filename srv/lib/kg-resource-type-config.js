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

export const RESOURCE_TYPE_CONFIG = [
  {
    type: 'learning-journey',
    icon: '🎓',
    singular: 'Learning journey',
    plural: 'Learning journeys',
    priority: 10,
    metaTemplate: 'Level · Duration',
    renderMeta(r) {
      const parts = [];
      if (r.level) parts.push(formatLevel(r.level));
      if (r.durationHours) parts.push(`${r.durationHours}h`);
      return parts.length ? ' · ' + parts.join(' · ') : '';
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
      const parts = [];
      if (r.authorName) parts.push(`by ${r.authorName}`);
      if (r.postedAt) parts.push(formatDate(r.postedAt));
      return parts.length ? ' · ' + parts.join(' · ') : '';
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
      const parts = [];
      if (r.effortLevel) parts.push(`effort ${r.effortLevel}`);
      if (r.categoryLabel) parts.push(r.categoryLabel);
      return parts.length ? ' · ' + parts.join(' · ') : '';
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
      const parts = [];
      if (r.channelTitle) parts.push(`by ${r.channelTitle}`);
      if (r.publishedAt) parts.push(formatDate(r.publishedAt));
      return parts.length ? ' · ' + parts.join(' · ') : '';
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
      let out = ' · Official reference';
      if (r.category) out += ` · ${r.category}`;
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
      const parts = [];
      if (r.language) parts.push(r.language);
      if (r.stars) parts.push(`${r.stars} stars`);
      if (r.lastCommitAt) parts.push(`Updated ${formatRelativeMonth(r.lastCommitAt)}`);
      return parts.length ? ' · ' + parts.join(' · ') : '';
    },
  },
];
