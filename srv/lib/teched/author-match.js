// srv/lib/teched/author-match.js
//
// Pure, fail-open name→authorLogin matcher for TechEd and Devtoberfest speakers
// (issue #2355, Unit 8). Given an AuthorIndex (hugo/data/author_index.json
// shape: Record<login, {login, displayName, ...}>) and a speaker name, returns
// the unique matching GitHub login, or null when no unambiguous match exists.
//
// Strategy: build a map of normalized displayName → login from the author
// index. "Normalized" means lowercase + trim + collapse internal whitespace.
// If a normalized name maps to MORE THAN ONE login (ambiguous), exclude it
// entirely — correctness over coverage. Only 1:1 matches produce a link.
//
// CommonJS (the srv/lib convention) so it can be required by both the CAP
// server (devtoberfest-feed.js) and, once the index is on-disk, by
// scripts/fetch-teched.ts (ESM, but can import CJS).

'use strict';

/**
 * Normalize a speaker/author display name to a lowercase, whitespace-collapsed
 * string for comparison. Returns '' for null/undefined/blank.
 * @param {string|null|undefined} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Build a lookup map from normalized displayName → login from an author index.
 * Entries with an ambiguous (colliding) normalized name are excluded.
 *
 * @param {Record<string, {login: string, displayName: string}>} authorIndex
 * @returns {Map<string, string>}  normalized-name → login (1:1 only)
 */
function buildNameToLoginMap(authorIndex) {
  if (!authorIndex || typeof authorIndex !== 'object') return new Map();
  // First pass: collect all logins per normalized name.
  const nameToLogins = new Map();
  for (const entry of Object.values(authorIndex)) {
    if (!entry || typeof entry !== 'object') continue;
    const key = normalizeName(entry.displayName);
    if (!key) continue;
    if (!nameToLogins.has(key)) nameToLogins.set(key, []);
    nameToLogins.get(key).push(entry.login);
  }
  // Second pass: keep only unambiguous (1:1) mappings.
  const result = new Map();
  for (const [key, logins] of nameToLogins) {
    if (logins.length === 1) result.set(key, logins[0]);
    // >1 login for the same displayName → ambiguous, excluded
  }
  return result;
}

/**
 * Resolve a speaker name to its authorLogin.
 * Returns null when there is no unambiguous match.
 *
 * @param {string|null|undefined} speakerName
 * @param {Map<string, string>} nameToLoginMap  from buildNameToLoginMap()
 * @returns {string|null}
 */
function resolveAuthorLogin(speakerName, nameToLoginMap) {
  const key = normalizeName(speakerName);
  if (!key) return null;
  return nameToLoginMap.get(key) ?? null;
}

/**
 * Enrich an array of speaker objects with `authorLogin` (string|null).
 * Mutates in place AND returns the array for convenience.
 * Fail-open: if authorIndex is missing/invalid, attaches null to every speaker.
 *
 * @template {{ name?: string|null }} T
 * @param {T[]} speakers
 * @param {Record<string, {login: string, displayName: string}>} authorIndex
 * @returns {(T & { authorLogin: string|null })[]}
 */
function enrichSpeakersWithAuthorLogin(speakers, authorIndex) {
  const map = buildNameToLoginMap(authorIndex);
  for (const sp of speakers) {
    sp.authorLogin = resolveAuthorLogin(sp.name, map);
  }
  return speakers;
}

module.exports = { normalizeName, buildNameToLoginMap, resolveAuthorLogin, enrichSpeakersWithAuthorLogin };
