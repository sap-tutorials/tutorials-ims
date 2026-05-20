import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

export const MAX_CHUNK_CHARS = 8000;

/**
 * Decompress a gzipped HTML buffer and return per-step text records.
 * Handles both Hugo parser formats:
 *   v1 — `<div class="accordion-content" data-step="N">`
 *   v2 — `<section data-step="N">`
 *
 * Returns `[]` for malformed input or HTML without step markers.
 *
 * @param {Buffer} gzBuffer
 * @returns {Array<{stepNumber: number, text: string, charCount: number}>}
 */
export function extractStepText(gzBuffer) {
  let html;
  try {
    html = gunzipSync(gzBuffer).toString('utf8');
  } catch {
    return [];
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  const nodes = $('[data-step]');
  if (nodes.length === 0) return [];

  const out = [];
  nodes.each((_, el) => {
    const num = Number($(el).attr('data-step'));
    if (!Number.isInteger(num) || num < 1) return;
    const raw = $(el).text();
    const text = truncateAtSentence(normalise(raw), MAX_CHUNK_CHARS);
    if (!text) return;
    out.push({ stepNumber: num, text, charCount: text.length });
  });
  return out;
}

function normalise(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function truncateAtSentence(s, max) {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastDot = slice.lastIndexOf('.');
  if (lastDot > max * 0.5) return slice.slice(0, lastDot + 1).trimEnd();
  return slice.trimEnd();
}
