// srv/puzzle-service.js
// PuzzleService handler — Task 5: check action (slot-level grading, 404 on unknown slug).
// Task 6 handlers (saveProgress / getProgress / complete) are stubbed below.

import cds from '@sap/cds';
import { gradeEntries } from './lib/puzzle-grading.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export default class PuzzleService extends cds.ApplicationService {

  async init() {
    const db = await cds.connect.to('db');
    const { Puzzles } = cds.entities('com.sap.developers.ims');

    // Canonicalize slug to lowercase.
    const canon = (s) => String(s || '').toLowerCase();

    // Load solution for a slug in its own query (never mixed with other metadata
    // columns — follows the LOB-locator hygiene pattern used across this codebase).
    const loadPuzzle = async (slug) => {
      const s = canon(slug);
      if (!SLUG_RE.test(s)) return null;
      return SELECT.one.from(Puzzles)
        .columns('ID', 'legacyId', 'title', 'solution')
        .where({ slug: s });
    };

    // ── check ─────────────────────────────────────────────────────────────────
    // Grade whole-word slot submissions server-side. Returns per-slot booleans
    // + a `complete` flag. Answers are NEVER returned.
    this.on('check', async (req) => {
      const { slug, entries } = req.data;
      const puzzle = await loadPuzzle(slug);
      if (!puzzle) return req.reject(404, 'Puzzle not found');
      try {
        return gradeEntries({ solution: puzzle.solution, entries: entries || [] });
      } catch (e) {
        cds.log('puzzle').warn('check grade failed:', e.message);
        return { results: [], complete: false };
      }
    });

    // ── Task 6 (progress / completion) ────────────────────────────────────────
    // Handlers for saveProgress, getProgress, complete are wired by Task 6
    // via _initProgressAndComplete (called below).
    await this._initProgressAndComplete({ db, Puzzles, canon, loadPuzzle });

    return super.init();
  }

  /**
   * Stub filled in Task 6.
   * Wires saveProgress / getProgress / complete handlers.
   */
  // eslint-disable-next-line no-unused-vars
  async _initProgressAndComplete(_ctx) {
    // filled in Task 6
  }
}
