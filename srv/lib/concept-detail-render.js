import ejs from 'ejs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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
 * Renders one concept detail page.
 *
 * Pure function of its inputs — the only I/O is the template read at module
 * load. Markup mirrors hugo/layouts/concepts/single.html so the CAP-served
 * concept-<slug> BLOB is visually identical to the legacy Hugo output.
 *
 * @param {object} concept  {slug,name,description,teaches[],requires[],requiredBy[],relatedTo[]}
 *   Relationship arrays hold {slug,title[,experienceTag,stepCount,description]}.
 * @param {object} phase4   {learningJourneys[],blogPosts[],discoveryMissions[],
 *   videos[],apiDocs[],samples[],helpDocs[],communityEvents[]} — each an array
 *   of {slug,title,url,...type-specific meta}.
 * @param {object} shell    {shellHead,shellHeader,shellFooter} — trusted HTML
 *   fragments from the __shell__ sidecar in ContentFiles.
 * @returns {{html: string, gzipped: Buffer, contentHash: string}}
 *   contentHash is the hex SHA-256 of the un-gzipped HTML bytes.
 */
export function renderConceptDetail(concept, phase4, shell) {
  if (!concept || typeof concept.slug !== 'string' || typeof concept.name !== 'string') {
    throw new Error('renderConceptDetail: concept.slug and concept.name are required');
  }
  if (!shell || typeof shell.shellHead !== 'string') {
    throw new Error('renderConceptDetail: shell fragments missing — __shell__ sidecar not yet published');
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
    shellHead: shell.shellHead,
    shellHeader: shell.shellHeader || '',
    shellFooter: shell.shellFooter || '',
    escapeHtml,
  };
  const html = TEMPLATE(ctx);
  const gzipped = gzipSync(Buffer.from(html, 'utf-8'));
  const contentHash = createHash('sha256').update(html, 'utf-8').digest('hex');
  return { html, gzipped, contentHash };
}
