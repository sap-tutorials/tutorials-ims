// scripts/parsers/directives/tut-walkthrough.ts
//
// Walkthrough container directive — pairs a code fence with an ordered list
// of notes where each note references a line range (e.g. {1} or {1-3}).
// Activating a note highlights the corresponding lines in the code fence.
//
// Directive syntax:
//   :::walkthrough
//   ```js
//   const x = 1
//   const y = 2
//   ```
//
//   1. {1} Declares x
//   2. {2} Declares y
//   :::

import type { DirectiveDef, DirectiveRenderOutput } from '../directive-registry.js';
import { DirectiveParseError } from '../directives.js';

/**
 * Extract the code fence from the body.
 * Returns { codePart, notesPart, lineCount } or null if no fence found.
 *
 * codePart  — lines from first ``` to matching closing ``` (inclusive)
 * notesPart — remaining lines after the closing fence
 * lineCount — number of code lines between the fences (exclusive)
 */
function extractFenceAndNotes(body: string): {
  codePart: string;
  notesPart: string;
  lineCount: number;
} | null {
  const lines = body.split('\n');

  // Find the first opening fence line
  let openIdx = -1;
  let fenceMarker = '';
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(`{3,})([\w]*)/);
    if (m) {
      openIdx = i;
      fenceMarker = m[1]; // e.g. "```" or "````"
      break;
    }
  }

  if (openIdx === -1) return null;

  // Find the matching closing fence (same or longer backtick run)
  let closeIdx = -1;
  const closingRe = new RegExp(`^${fenceMarker}\`*\\s*$`);
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (closingRe.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }

  if (closeIdx === -1) return null;

  // Code lines are those between open and close (exclusive)
  const lineCount = closeIdx - openIdx - 1;

  // codePart = lines from openIdx to closeIdx inclusive
  const codePart = lines.slice(openIdx, closeIdx + 1).join('\n');

  // notesPart = everything after the closing fence
  const notesPart = lines.slice(closeIdx + 1).join('\n').trimStart();

  return { codePart, notesPart, lineCount };
}

/**
 * Parse note list items from the notes section.
 * Each item starts with `{N}` or `{N-M}`.
 * Returns an array of { ref, start, end, rest } objects.
 */
interface NoteRef {
  ref: string;   // original e.g. "1" or "1-2"
  start: number;
  end: number;
  rest: string;  // text after the {N} prefix
  raw: string;   // the whole list item line
}

function parseNoteRefs(notesPart: string): NoteRef[] {
  const refs: NoteRef[] = [];
  const lines = notesPart.split('\n');
  for (const line of lines) {
    // Match ordered or unordered list items with {N} or {N-M}
    const m = line.match(/^(?:\d+\.|[-*])\s*\{(\d+)(?:-(\d+))?\}(.*)$/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : start;
      const ref = m[2] ? `${m[1]}-${m[2]}` : m[1];
      refs.push({ ref, start, end, rest: m[3], raw: line });
    }
  }
  return refs;
}

export const walkthroughDef: DirectiveDef = {
  name: 'walkthrough',
  kinds: ['container'],
  summary: 'Pairs a code fence with annotated notes that highlight line ranges on click.',
  attrs: {},
  since: '1.0.0',

  render(node: any, _ctx: any): DirectiveRenderOutput {
    const body: string = node.body ?? '';
    const extracted = extractFenceAndNotes(body);

    if (!extracted) {
      // No code fence found — emit body as-is in params
      return { params: { code: '', notes: body } };
    }

    const { codePart, notesPart, lineCount } = extracted;

    // Validate all note line references
    const refs = parseNoteRefs(notesPart);
    for (const ref of refs) {
      if (ref.start > lineCount || ref.end > lineCount || ref.start < 1 || ref.end < ref.start) {
        throw new DirectiveParseError(
          `walkthrough: line reference {${ref.ref}} is out of range (fence has ${lineCount} lines)`,
          (node as any).attrs?.slug ?? 'walkthrough',
          (node as any).line ?? 0,
          0,
          'walkthrough',
          'invalid-attr',
        );
      }
    }

    return { params: { code: codePart, notes: notesPart } };
  },

  toText(node: any, _ctx: any): string {
    const body: string = node.body ?? '';
    const extracted = extractFenceAndNotes(body);

    if (!extracted) {
      return body;
    }

    const { codePart, notesPart } = extracted;

    // Transform note items: replace {N} or {N-M} prefix with (lines N) or (lines N–M)
    const transformedNotes = notesPart
      .split('\n')
      .map(line => {
        return line.replace(
          /^((?:\d+\.|[-*])\s*)\{(\d+)(?:-(\d+))?\}/,
          (_match, prefix, start, end) => {
            if (end) {
              return `${prefix}(lines ${start}–${end})`; // en-dash
            }
            return `${prefix}(lines ${start})`;
          },
        );
      })
      .join('\n');

    return `${codePart}\n\n${transformedNotes}`;
  },
};
