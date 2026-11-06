// packages/mcp/option-filter.js
//
// Pure OPTION-block variant filter for tutorial markdown source.
// No CDS, no DB, no metrics — safe to import without a running server.
//
// OPTION block syntax (Hugo shortcode / tutorial parser v2):
//   [OPTION BEGIN [Label] sync=key]
//   ... content ...
//   [OPTION END]
//
// When a `variants` map is provided (e.g. { runtime: 'java' }) and the group
// carries a `sync=key` attribute whose key exists in `variants`, only the
// matching variant's content is kept (without OPTION markers).
// When no match or no preference, all variants are kept with
// `#### Option: <label>` headings.
// Non-OPTION text is passed through unchanged.

// ---------------------------------------------------------------------------
// Canonicalisation
// ---------------------------------------------------------------------------

// Preset tables inlined from scripts/parsers/sync-presets.ts so this module
// stays CDS-free (the .ts source can't be directly imported from plain ESM JS).
const SYNC_PRESETS = {
  runtime: {
    'Node.js': ['Node', 'NodeJS', 'Node.js', 'JavaScript', 'TypeScript', 'CAP Node.js'],
    'Java': ['Java', 'CAP Java', 'Spring'],
    'Python': ['Python'],
  },
  account: {
    'Trial': ['Trial', 'BTP Trial', 'Trial account'],
    'Free Tier': ['Free Tier'],
    'Enterprise': ['Enterprise', 'Pay-As-You-Go', 'PAYG', 'CPEA', 'BTPEA'],
  },
  ide: {
    'BAS': ['BAS', 'Business Application Studio', 'SAP BAS'],
    'VS Code': ['VS Code', 'Visual Studio Code', 'VSCode'],
  },
};

/**
 * Return the canonical value for a label within a preset key.
 * Case-insensitive. Returns null when unknown.
 * Mirrors canonicalForLabel from scripts/parsers/sync-presets.ts.
 *
 * @param {string} key    Preset key (e.g. 'runtime')
 * @param {string} label  Label text from OPTION BEGIN
 * @returns {string|null}
 */
function canonicalForLabel(key, label) {
  const preset = SYNC_PRESETS[key];
  if (!preset) return null;
  const lowerLabel = label.trim().toLowerCase();
  for (const [canonical, aliases] of Object.entries(preset)) {
    for (const alias of aliases) {
      if (alias.toLowerCase() === lowerLabel) return canonical;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// OPTION block parsing
// ---------------------------------------------------------------------------

// Regex for [OPTION BEGIN [Label] sync=key] — captures label and optional sync attr.
// Intentionally simple: label is the text between [ ], sync= is the first
// space-separated attribute after the label bracket.
const BEGIN_RE = /^\[OPTION BEGIN \[([^\]]+)\]([^\]]*)\]/;
const END_RE   = /^\[OPTION END\]/;

/**
 * @typedef {{ label: string, syncKey: string|null, lines: string[] }} OptionBlock
 * @typedef {OptionBlock[]} OptionGroup
 */

/**
 * Parse a markdown string into alternating segments of non-OPTION text and
 * OPTION groups (consecutive OPTION blocks).
 *
 * @param {string} markdown
 * @returns {Array<{ type: 'text', lines: string[] } | { type: 'group', blocks: OptionGroup }>}
 */
function parseSegments(markdown) {
  const lines = markdown.split('\n');
  const segments = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const beginMatch = BEGIN_RE.exec(line);
    if (!beginMatch) {
      // Non-OPTION line — accumulate into current text segment.
      const last = segments[segments.length - 1];
      if (last && last.type === 'text') {
        last.lines.push(line);
      } else {
        segments.push({ type: 'text', lines: [line] });
      }
      i++;
      continue;
    }

    // We're at an OPTION BEGIN — collect this block.
    const label   = beginMatch[1].trim();
    const attrs   = beginMatch[2].trim();
    const syncMatch = /sync=(\S+)/.exec(attrs);
    const syncKey = syncMatch ? syncMatch[1] : null;

    const blockLines = [];
    i++; // move past [OPTION BEGIN ...]
    while (i < lines.length && !END_RE.test(lines[i])) {
      blockLines.push(lines[i]);
      i++;
    }
    if (i < lines.length) i++; // skip [OPTION END]

    const block = { label, syncKey, lines: blockLines };

    // Attach to an existing open group or start a new one.
    // Consecutive OPTION blocks (with only blank lines in between) belong to
    // the SAME group. Rule:
    //   - Direct group before this block → same group.
    //   - Blank-only text segment before this block AND a group before THAT →
    //     discard the blank separator and merge into the preceding group.
    //   - Blank-only text segment with no preceding group → new group (first block).
    //   - Non-blank text before this block → new group.
    const last = segments[segments.length - 1];
    if (last && last.type === 'group') {
      // Direct group → same group.
      last.blocks.push(block);
    } else if (last && last.type === 'text') {
      const nonBlank = last.lines.filter(l => l.trim() !== '');
      if (nonBlank.length === 0) {
        // Blank separator — check what's before it.
        const penultimate = segments[segments.length - 2];
        if (penultimate && penultimate.type === 'group') {
          // Drop the blank separator and append to the preceding group.
          segments.pop();
          penultimate.blocks.push(block);
        } else {
          // No preceding group (first OPTION block after text/nothing).
          segments.pop(); // drop blank text segment
          segments.push({ type: 'group', blocks: [block] });
        }
      } else {
        // Real text content before this block — new group.
        segments.push({ type: 'group', blocks: [block] });
      }
    } else {
      segments.push({ type: 'group', blocks: [block] });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Variant filter
// ---------------------------------------------------------------------------

/**
 * Filter OPTION-block variants in tutorial markdown by the given preferences.
 *
 * @param {string} markdown
 *   Raw tutorial step source markdown, possibly containing OPTION blocks.
 * @param {Record<string, string>} variants
 *   Preference map, e.g. `{ runtime: 'java' }`. Case-insensitive matching via
 *   the preset tables.  Empty object → keep all variants (with headers).
 * @returns {string} Filtered markdown.
 */
export function filterVariants(markdown, variants) {
  if (!markdown) return markdown;
  if (!variants || typeof variants !== 'object') return markdown;

  const segments = parseSegments(markdown);

  const outputParts = [];

  for (const seg of segments) {
    if (seg.type === 'text') {
      outputParts.push(seg.lines.join('\n'));
      continue;
    }

    // seg.type === 'group'
    const { blocks } = seg;

    // Determine if any block in this group has a sync= key that matches a
    // preference in `variants`.
    let preferenceKey = null;
    let preferenceCanonical = null;

    for (const block of blocks) {
      if (!block.syncKey) continue;
      const prefValue = variants[block.syncKey];
      if (prefValue === undefined || prefValue === null || prefValue === '') continue;
      // We have a preference for this sync key.
      const canonical = canonicalForLabel(block.syncKey, prefValue);
      if (canonical !== null) {
        preferenceKey = block.syncKey;
        preferenceCanonical = canonical;
        break; // First matching sync key wins.
      }
    }

    if (preferenceKey !== null) {
      // Find the block(s) whose label canonicalises to the preferred value.
      const matches = blocks.filter(b => {
        if (b.syncKey !== preferenceKey) return false;
        const c = canonicalForLabel(b.syncKey, b.label);
        return c !== null && c === preferenceCanonical;
      });

      if (matches.length > 0) {
        // Emit matched variant content only (no OPTION markers).
        for (const m of matches) {
          outputParts.push(m.lines.join('\n'));
        }
      } else {
        // No block matched — fall back to all with headers.
        for (const b of blocks) {
          outputParts.push(`#### Option: ${b.label}`);
          outputParts.push(b.lines.join('\n'));
        }
      }
    } else {
      // No preference applies to this group — emit all with labelled headers.
      for (const b of blocks) {
        outputParts.push(`#### Option: ${b.label}`);
        outputParts.push(b.lines.join('\n'));
      }
    }
  }

  // Reassemble, trimming redundant leading/trailing blanks per part.
  return outputParts.join('\n');
}
