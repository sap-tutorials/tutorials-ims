// srv/puzzle-service.js
// PuzzleService handler — Task 5: check action (slot-level grading, 404 on unknown slug).
// Task 6: saveProgress / getProgress / complete (progress persistence + server-graded completion).

import cds from '@sap/cds';
import { gradeEntries, deriveSlotIds } from './lib/puzzle-grading.js';
import { getNextLegacyId } from './lib/legacy-id.js';
import { resolveUserSapId } from './lib/resolve-db-user.js';

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
   * Wires saveProgress / getProgress / complete handlers.
   * Mirrors the user auto-provision pattern from developer-service.js completeStep.
   */
  async _initProgressAndComplete({ db, Puzzles, canon, loadPuzzle }) {
    const { PuzzleProgress, Users, TaskRecords } = cds.entities('com.sap.developers.ims');

    // Resolve or auto-provision the DB user row (mirrors developer-service.js:168-185).
    const resolveOrCreateUser = async (user) => {
      const sapId = resolveUserSapId(user);
      if (!sapId) return null;
      let dbUser = await SELECT.one.from(Users).where({ sapId });
      if (!dbUser) {
        await INSERT.into(Users).entries({
          uuid: user.id,
          sapId,
          legacyId: await getNextLegacyId('Users', db),
          email: user.attr?.email || '',
          firstName: user.attr?.given_name || '',
          lastName: user.attr?.family_name || '',
        });
        dbUser = await SELECT.one.from(Users).where({ sapId });
      }
      return dbUser;
    };

    // ── saveProgress ─────────────────────────────────────────────────────────
    // Upsert the caller's in-progress grid. Creates the PuzzleProgress row on
    // first save; updates filledGrid on subsequent saves.
    this.on('saveProgress', async (req) => {
      const { slug, filledGrid } = req.data;
      const puzzle = await loadPuzzle(slug);
      if (!puzzle) return req.reject(404, 'Puzzle not found');
      const dbUser = await resolveOrCreateUser(req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');
      const existing = await SELECT.one.from(PuzzleProgress)
        .where({ user_ID: dbUser.ID, puzzle_ID: puzzle.ID });
      if (existing) {
        await UPDATE(PuzzleProgress, existing.ID).set({ filledGrid });
      } else {
        await INSERT.into(PuzzleProgress).entries({
          ID: cds.utils.uuid(),
          user_ID: dbUser.ID,
          puzzle_ID: puzzle.ID,
          filledGrid,
          attemptNumber: 1,
        });
      }
      return true;
    });

    // ── getProgress ───────────────────────────────────────────────────────────
    // Return the caller's saved grid (or an empty grid if none stored yet).
    this.on('getProgress', async (req) => {
      const { slug } = req.data;
      const puzzle = await loadPuzzle(slug);
      if (!puzzle) return req.reject(404, 'Puzzle not found');
      const dbUser = await resolveOrCreateUser(req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');
      const row = await SELECT.one.from(PuzzleProgress)
        .where({ user_ID: dbUser.ID, puzzle_ID: puzzle.ID });
      return { filledGrid: row?.filledGrid || '{}', attemptNumber: row?.attemptNumber ?? 1 };
    });

    // ── complete ──────────────────────────────────────────────────────────────
    // Re-grade the stored grid server-side. Writes an idempotent PUZZLE
    // TaskRecord only on a fully correct solve. Returns:
    //   { recorded: true,  alreadyComplete: false } — first completion
    //   { recorded: false, alreadyComplete: true  } — already recorded
    //   { recorded: false, alreadyComplete: false } — not fully solved yet
    this.on('complete', async (req) => {
      const { slug } = req.data;
      const puzzle = await loadPuzzle(slug);
      if (!puzzle) return req.reject(404, 'Puzzle not found');
      const dbUser = await resolveOrCreateUser(req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');

      // Re-grade the stored grid against the server-side solution.
      const prog = await SELECT.one.from(PuzzleProgress)
        .where({ user_ID: dbUser.ID, puzzle_ID: puzzle.ID });
      const filled = (() => {
        try { return JSON.parse(prog?.filledGrid || '{}'); } catch { return {}; }
      })();

      // Build slot entries from the filled grid using the solution key space.
      // deriveSlotIds (shared with gradeEntries) discovers all slot start-ids
      // from the solution map; wordAt walks each slot and returns the filled word.
      const sol = (() => {
        try { return JSON.parse(puzzle.solution || '{}'); } catch { return {}; }
      })();

      const allSlotIds = deriveSlotIds(sol);

      const wordAt = (slotId) => {
        const m = /^(\d+)-(\d+)-(across|down)$/.exec(slotId);
        let r = +m[1], c = +m[2];
        const dir = m[3];
        const out = [];
        while (sol[`${r},${c}`] !== undefined) {
          out.push(filled[`${r},${c}`] || '');
          if (dir === 'across') c++; else r++;
        }
        return out.join('');
      };

      const entries = [...allSlotIds].map(id => ({ slotId: id, word: wordAt(id) }));
      const graded = gradeEntries({ solution: puzzle.solution, entries });
      if (!graded.complete) return { recorded: false, alreadyComplete: false };

      // Idempotency check: skip if a non-SUPERSEDED PUZZLE record already exists.
      const existing = await SELECT.one.from(TaskRecords).where({
        user_ID: dbUser.ID,
        taskLegacyId: puzzle.legacyId,
        taskType: 'PUZZLE',
        status: { '!=': 'SUPERSEDED' },
      });
      if (existing) return { recorded: false, alreadyComplete: true };

      await INSERT.into(TaskRecords).entries({
        user_ID: dbUser.ID,
        taskLegacyId: puzzle.legacyId,
        taskType: 'PUZZLE',
        status: 'COMPLETED',
        progress: 100,
        completionDate: new Date().toISOString(),
        titleSnapshot: puzzle.title,
        legacyId: await getNextLegacyId('TaskRecords', db),
        attemptNumber: 1,
      });
      return { recorded: true, alreadyComplete: false };
    });
  }
}
