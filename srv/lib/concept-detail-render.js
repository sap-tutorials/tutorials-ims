import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__dirname, 'templates', 'concept-detail.ejs');
const TEMPLATE_SRC = readFileSync(TEMPLATE_PATH, 'utf-8');
const TEMPLATE = ejs.compile(TEMPLATE_SRC, { filename: TEMPLATE_PATH });

// HTML-escape helper injected into the template context. EJS `<%=` handles
// escaping for scalar interpolation, but the external-link card helper builds
// small HTML fragments (link vs no-link variants, meta spans) in JS where the
// caller must escape user-visible values explicitly. Mirrors ejs's own escape.
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Renders one concept detail page BODY — the `<article class="concept-page">`
 * fragment that goes inside `<main>`. The full document is produced by the
 * publish path (srv/lib/publish-concepts.js) via composeShell(shell, body,
 * meta), the same way the group/mission catalog pages compose their bodies
 * (srv/lib/content-store.js:renderCatalogPage). This keeps concept pages
 * byte-identical in chrome to the rest of the site with zero CSS to port and
 * no duplicated <head>/<header>/<footer> scaffold.
 *
 * Pure function of its inputs — the only I/O is the template read at module
 * load. Markup mirrors hugo/layouts/concepts/single.html.
 *
 * @param {object} concept  {slug,name,description,teaches[],requires[],requiredBy[],relatedTo[]}
 *   Relationship arrays hold {slug,title[,experienceTag,stepCount,description]}
 *   (teaches) or {slug,name[,description]} — but note buildConceptsPayload
 *   emits concept refs with `name`; the template reads `.title` on relationship
 *   cards, so callers map name→title (see publish-concepts.js).
 * @param {object} phase4   {learningJourneys[],blogPosts[],discoveryMissions[],
 *   videos[],apiDocs[],samples[],helpDocs[],communityEvents[]} — each an array
 *   of {slug,title,url,...type-specific meta}.
 * @returns {{body: string, contentHash: string}}
 *   body is the article fragment; contentHash is the hex SHA-256 of the body
 *   bytes (a stable render signal — the publish path computes the delta hash
 *   over the composed full document, which also folds in the shell version).
 */
export function renderConceptDetail(concept, phase4) {
  if (!concept || typeof concept.slug !== 'string' || typeof concept.name !== 'string') {
    throw new Error('renderConceptDetail: concept.slug and concept.name are required');
  }
  const p4 = phase4 || {};
  const ctx = {
    slug: concept.slug,
    name: concept.name,
    description: concept.description || '',
    teaches: concept.teaches || [],
    requires: concept.requires || [],
    requiredBy: concept.requiredBy || [],
    relatedTo: concept.relatedTo || [],
    learningJourneys: p4.learningJourneys || [],
    blogPosts: p4.blogPosts || [],
    discoveryMissions: p4.discoveryMissions || [],
    videos: p4.videos || [],
    apiDocs: p4.apiDocs || [],
    samples: p4.samples || [],
    helpDocs: p4.helpDocs || [],
    communityEvents: p4.communityEvents || [],
    escapeHtml,
  };
  // Wrap in <main> so the served concept page has a top-level landmark. The
  // __shell__ chrome only provides a <!-- MAIN --> marker (its own <main> was
  // substituted at publish time), so — like the browse/topics bodies
  // (content-store.js) — the body must supply its own <main>. Without it the
  // concept page had zero landmarks (axe region: title/sections outside main).
  const body = `<main>${TEMPLATE(ctx)}</main>`;
  const contentHash = createHash('sha256').update(body, 'utf-8').digest('hex');
  return { body, contentHash };
}
