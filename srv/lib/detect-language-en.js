// srv/lib/detect-language-en.js
//
// v1 English-language heuristic for the SAP News classifier. (#1034)
// Returns 'en' when every character is Basic Latin + Latin-1 Supplement (+ common
// whitespace) AND at least 3 whitespace-bounded English function words are present
// (the/of/and/to/is/in/for/with, case-insensitive). Otherwise null.

const FN_WORDS = new Set(['the', 'of', 'and', 'to', 'is', 'in', 'for', 'with']);
const LATIN_RE = /^[\t\n\r\x20-\x7E\xA0-\xFF]*$/;
const TOKEN_RE = /[a-zA-Z]+/g;

/** @param {string|null|undefined} text */
export function detectLanguageEn(text) {
  if (!text) return null;
  if (!LATIN_RE.test(text)) return null;
  let hits = 0;
  const lower = text.toLowerCase();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(lower)) !== null) {
    if (FN_WORDS.has(m[0])) {
      hits++;
      if (hits >= 3) return 'en';
    }
  }
  return null;
}
