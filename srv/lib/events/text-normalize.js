// srv/lib/events/text-normalize.js
// Phase 4.8 (#765): normalize text sourced from RSS/HTML.
//
// RSS titles may contain HTML entities (`&amp;`, `&#8217;`, `&#x2019;`, ...).
// Decode them before writing to the DB so downstream renderers (Hugo, admin
// UI, KG projection) don't have to double-decode.
//
// Minimal, dependency-free. Named entities: & < > " ' `.
// Numeric entities: &#NNNN; (decimal) and &#xHHHH; (hex).

const NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
});

/**
 * Decode a small, safe set of HTML entities from a string.
 * Returns the input unchanged when it's not a non-empty string.
 * @param {string} str
 * @returns {string}
 */
export function decodeHtmlEntities(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, ref) => {
    if (ref[0] === '#') {
      const hex = ref[1] === 'x' || ref[1] === 'X';
      const num = parseInt(ref.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(num) && num >= 0 && num <= 0x10FFFF) {
        try {
          return String.fromCodePoint(num);
        } catch {
          return _match;
        }
      }
      return _match;
    }
    const key = ref.toLowerCase();
    return Object.prototype.hasOwnProperty.call(NAMED, key) ? NAMED[key] : _match;
  });
}
