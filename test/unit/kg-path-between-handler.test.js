// test/unit/kg-path-between-handler.test.js
//
// Unit tests for the findLearningPath Joule chat tool handler and descriptor.
// Issue #445 Phase 2 Task 5.
//
// Mocks: kg-sparql-client.js, kg/concepts-for-user.js, db.run
// No network / HANA access.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
  kgAdminRunSparql: vi.fn(),
  SparqlTimeoutError: class SparqlTimeoutError extends Error {
    constructor(message, opts = {}) {
      super(message)
      this.name = 'SparqlTimeoutError'
      this.sparql = opts.sparql
      this.timeoutMs = opts.timeoutMs
    }
  },
  SparqlSyntaxError: class SparqlSyntaxError extends Error {
    constructor(message, opts = {}) {
      super(message)
      this.name = 'SparqlSyntaxError'
      this.cause = opts.cause
      this.sparql = opts.sparql
      this.code = opts.code
    }
  },
}))

vi.mock('../../srv/lib/kg/concepts-for-user.js', () => ({
  getConceptsForUser: vi.fn(async () => ({ learned: [], partial: [], truncatedAt500: false })),
}))

const { kgQuery, SparqlTimeoutError, SparqlSyntaxError } =
  await import('../../srv/lib/kg-sparql-client.js')
const { getConceptsForUser } = await import('../../srv/lib/kg/concepts-for-user.js')
const { findLearningPathHandler, FIND_LEARNING_PATH_TOOL } =
  await import('../../srv/lib/kg/joule-tool-find-path.js')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Make a mock db that dispatches db.run() on SQL text substrings.
 *
 * @param {object} opts
 * @param {string|null} opts.taskRecordSlug - SLUG returned by the most-recent-COMPLETED query
 * @param {Array}       opts.tutorialRows   - rows returned by plain TUTORIALS hydration query
 * @param {Array}       opts.conceptLinkRows - rows returned by TUTORIALCONCEPTLINKS join query
 */
function makeDb({ taskRecordSlug = null, tutorialRows = [], conceptLinkRows = [] } = {}) {
  return {
    run: vi.fn(async (sqlOrCqn, _params) => {
      const sql = typeof sqlOrCqn === 'string' ? sqlOrCqn : String(sqlOrCqn)
      // Most-recent-COMPLETED lookup — has both TASKRECORDS and COMPLETED and TOP 1
      if (sql.includes('TASKRECORDS') && sql.includes('COMPLETED') && sql.includes('TOP 1')) {
        return taskRecordSlug ? [{ SLUG: taskRecordSlug }] : []
      }
      // TutorialConceptLinks join
      if (sql.includes('TUTORIALCONCEPTLINKS')) {
        return conceptLinkRows
      }
      // Plain Tutorials hydration (SELECT SLUG, TITLE, ESTIMATEDTIMEMINUTES ...)
      if (sql.includes('TUTORIALS')) {
        return tutorialRows
      }
      return []
    }),
  }
}

function makeTelemetry() {
  const emitted = []
  return { emitted, emit: (event, payload) => emitted.push({ event, payload }) }
}

/**
 * Build a minimal SPARQL-results+JSON response for the PATH_BETWEEN query
 * shape — the format KG_QUERY actually emits (Accept:
 * application/sparql-results+json). binding "b" = tutorial IRI, plus
 * "pathType", "pathTypeRank", "hopCount". (#1129: was XML; the proc never
 * emitted XML, so the old fixtures masked the parser bug — see
 * srv/lib/kg-path.js parsePathSparql history.)
 */
function buildJsonResponse(results) {
  return JSON.stringify({
    head: { vars: ['b', 'pathType', 'pathTypeRank', 'hopCount'] },
    results: {
      bindings: results.map(r => ({
        b: { type: 'uri', value: `https://developers.sap.com/kg/tutorial/${r.slug}` },
        pathType: { type: 'literal', value: r.pathType },
        pathTypeRank: {
          type: 'literal',
          datatype: 'http://www.w3.org/2001/XMLSchema#int',
          value: String(r.rank),
        },
        hopCount: {
          type: 'literal',
          datatype: 'http://www.w3.org/2001/XMLSchema#int',
          value: '0',
        },
      })),
    },
  })
}

function emptyJson() {
  return JSON.stringify({ head: { vars: [] }, results: { bindings: [] } })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FIND_LEARNING_PATH_TOOL descriptor', () => {
  it('has name "findLearningPath" and requires toSlug', () => {
    expect(FIND_LEARNING_PATH_TOOL.function.name).toBe('findLearningPath')
    expect(FIND_LEARNING_PATH_TOOL.function.parameters.required).toEqual(['toSlug'])
    expect(FIND_LEARNING_PATH_TOOL.type).toBe('function')
  })

  it('description names sibling tools getRelevantSteps and checkCode for collision avoidance', () => {
    const desc = FIND_LEARNING_PATH_TOOL.function.description
    expect(desc).toContain('getRelevantSteps')
    expect(desc).toContain('checkCode')
  })
})

describe('findLearningPathHandler — input validation', () => {
  it('returns friendly error for malformed toSlug (no throw)', async () => {
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'INVALID SLUG WITH SPACES!!' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/toSlug/i)
    expect(result).toMatch(/INVALID SLUG WITH SPACES!!/i)
  })

  it('returns friendly error for malformed fromSlug (no throw)', async () => {
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'cap-getting-started', fromSlug: 'BAD SLUG!!' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/fromSlug/i)
    expect(result).toMatch(/BAD SLUG!!/i)
  })
})

describe('findLearningPathHandler — fromSlug resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConceptsForUser.mockResolvedValue({ learned: [], partial: [], truncatedAt500: false })
  })

  it('uses provided fromSlug and calls kgQuery with correct params', async () => {
    kgQuery.mockResolvedValue({ response: emptyJson(), headers: '', latencyMs: 10 })

    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'cap-getting-started', fromSlug: 'abap-intro' },
      user: null,
      telemetry: makeTelemetry(),
    })

    expect(kgQuery).toHaveBeenCalledOnce()
    const callArgs = kgQuery.mock.calls[0][0]
    expect(callArgs.queryName).toBe('PATH_BETWEEN')
    expect(callArgs.params.fromSlug).toContain('abap-intro')
    expect(callArgs.params.toSlug).toContain('cap-getting-started')
  })

  it('infers fromSlug from user TaskRecords and emits fromSlugInferred:true', async () => {
    kgQuery.mockResolvedValue({ response: emptyJson(), headers: '', latencyMs: 10 })

    const db = makeDb({ taskRecordSlug: 'hana-cloud-intro' })
    const tel = makeTelemetry()

    await findLearningPathHandler({
      db,
      args: { toSlug: 'cap-getting-started' },
      user: { id: 'user-abc-123' },
      telemetry: tel,
    })

    // db.run must have been called for the TOP 1 TASKRECORDS query
    const sqlCalls = db.run.mock.calls.map(c => c[0])
    expect(sqlCalls.some(s => s.includes('TASKRECORDS') && s.includes('TOP 1'))).toBe(true)

    const requested = tel.emitted.find(e => e.event === 'kg.joule.path_requested')
    expect(requested).toBeDefined()
    expect(requested.payload.fromSlugInferred).toBe(true)
    expect(requested.payload.unanchored).toBe(false)
  })

  it('anchors to toSlug when no fromSlug + zero TaskRecords, emits unanchored:true', async () => {
    kgQuery.mockResolvedValue({ response: emptyJson(), headers: '', latencyMs: 10 })

    const db = makeDb({ taskRecordSlug: null })
    const tel = makeTelemetry()

    await findLearningPathHandler({
      db,
      args: { toSlug: 'cap-getting-started' },
      user: { id: 'user-xyz' },
      telemetry: tel,
    })

    const callArgs = kgQuery.mock.calls[0][0]
    expect(callArgs.params.fromSlug).toContain('cap-getting-started')
    expect(callArgs.params.toSlug).toContain('cap-getting-started')

    const requested = tel.emitted.find(e => e.event === 'kg.joule.path_requested')
    expect(requested.payload.unanchored).toBe(true)
  })

  it('anchors to toSlug when user is anonymous (no user.id), emits unanchored:true + hasUserId:false', async () => {
    kgQuery.mockResolvedValue({ response: emptyJson(), headers: '', latencyMs: 10 })

    const tel = makeTelemetry()

    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'cap-getting-started' },
      user: null,
      telemetry: tel,
    })

    const requested = tel.emitted.find(e => e.event === 'kg.joule.path_requested')
    expect(requested.payload.unanchored).toBe(true)
    expect(requested.payload.hasUserId).toBe(false)
  })
})

describe('findLearningPathHandler — result parsing and rendering', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConceptsForUser.mockResolvedValue({ learned: [], partial: [], truncatedAt500: false })
  })

  it('parses XML and renders both tutorial entries with their titles', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'abap-intro', pathType: 'PREREQ', rank: 1 },
        { slug: 'cap-getting-started', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 20,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'abap-intro', TITLE: 'ABAP Introduction', ESTIMATEDTIMEMINUTES: 30 },
        { SLUG: 'cap-getting-started', TITLE: 'CAP Getting Started', ESTIMATEDTIMEMINUTES: 45 },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'cap-getting-started', fromSlug: 'abap-intro' },
      user: null,
      telemetry: makeTelemetry(),
    })

    expect(result).toContain('ABAP Introduction')
    expect(result).toContain('CAP Getting Started')
  })

  it('returns "no path found" message when XML has no candidates', async () => {
    kgQuery.mockResolvedValue({
      response: emptyJson(),
      headers: '',
      latencyMs: 5,
    })

    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'rare-tutorial', fromSlug: 'abap-intro' },
      user: null,
      telemetry: makeTelemetry(),
    })

    expect(result).toMatch(/couldn't find a path/i)
    expect(result).toContain('abap-intro')
    expect(result).toContain('rare-tutorial')
  })

  it('promotes toSlug to position 1 when exactTargetReached', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'intermediate-step', pathType: 'PREREQ', rank: 1 },
        { slug: 'target-tutorial', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 10,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'intermediate-step', TITLE: 'Intermediate Step', ESTIMATEDTIMEMINUTES: 20 },
        { SLUG: 'target-tutorial', TITLE: 'Target Tutorial', ESTIMATEDTIMEMINUTES: 40 },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'target-tutorial', fromSlug: 'start-tutorial' },
      user: null,
      telemetry: makeTelemetry(),
    })

    // target-tutorial should appear before intermediate-step in the rendered list
    const targetIdx = result.indexOf('Target Tutorial')
    const intermediateIdx = result.indexOf('Intermediate Step')
    expect(targetIdx).toBeLessThan(intermediateIdx)
  })

  it('deduplicates by slug — lowest pathTypeRank wins (PREREQ over CO_COMPLETED over SHARED)', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'dup-tutorial', pathType: 'PREREQ', rank: 1 },
        { slug: 'dup-tutorial', pathType: 'CO_COMPLETED', rank: 2 },
        { slug: 'dup-tutorial', pathType: 'SHARED_CONCEPT', rank: 3 },
      ]),
      headers: '',
      latencyMs: 10,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'dup-tutorial', TITLE: 'Deduplicated Tutorial', ESTIMATEDTIMEMINUTES: 15 },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'dup-tutorial', fromSlug: 'start-tutorial' },
      user: null,
      telemetry: makeTelemetry(),
    })

    // Should appear exactly once
    const count = (result.match(/Deduplicated Tutorial/g) || []).length
    expect(count).toBe(1)

    // Reason for PREREQ arm
    expect(result).toContain('Prerequisite chain')
  })

  it('renders estimated time in minutes', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'timed-tutorial', pathType: 'SHARED_CONCEPT', rank: 3 },
      ]),
      headers: '',
      latencyMs: 5,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'timed-tutorial', TITLE: 'Timed Tutorial', ESTIMATEDTIMEMINUTES: 25 },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'timed-tutorial', fromSlug: 'start-tutorial' },
      user: null,
      telemetry: makeTelemetry(),
    })

    expect(result).toContain('~25 min')
  })
})

describe('findLearningPathHandler — user-coverage filter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('filters out fully-covered candidates (leaves no-path message when only one candidate is covered)', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'covered-tutorial', pathType: 'PREREQ', rank: 1 },
      ]),
      headers: '',
      latencyMs: 10,
    })

    // covered-tutorial teaches only concept-a; user has already learned concept-a
    getConceptsForUser.mockResolvedValue({
      learned: ['concept-a'],
      partial: [],
      truncatedAt500: false,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'covered-tutorial', TITLE: 'Already Done Tutorial', ESTIMATEDTIMEMINUTES: 20 },
      ],
      conceptLinkRows: [
        { SLUG: 'covered-tutorial', CONCEPT_SLUG: 'concept-a' },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'other-target', fromSlug: 'start-tutorial' },
      user: { id: 'user-123' },
      telemetry: makeTelemetry(),
    })

    // The only candidate was covered, so no path found
    expect(result).toMatch(/couldn't find a path/i)
  })

  it('never drops toSlug even if fully covered by user concepts', async () => {
    kgQuery.mockResolvedValue({
      response: buildJsonResponse([
        { slug: 'covered-target', pathType: 'PREREQ', rank: 1 },
      ]),
      headers: '',
      latencyMs: 10,
    })

    // covered-target teaches only concept-x; user has already learned concept-x
    getConceptsForUser.mockResolvedValue({
      learned: ['concept-x'],
      partial: [],
      truncatedAt500: false,
    })

    const db = makeDb({
      tutorialRows: [
        { SLUG: 'covered-target', TITLE: 'Covered Target Tutorial', ESTIMATEDTIMEMINUTES: 30 },
      ],
      conceptLinkRows: [
        { SLUG: 'covered-target', CONCEPT_SLUG: 'concept-x' },
      ],
    })

    const result = await findLearningPathHandler({
      db,
      args: { toSlug: 'covered-target', fromSlug: 'start-tutorial' },
      user: { id: 'user-456' },
      telemetry: makeTelemetry(),
    })

    // toSlug is never dropped even though all its concepts are learned
    expect(result).toContain('Covered Target Tutorial')
  })
})

describe('findLearningPathHandler — telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getConceptsForUser.mockResolvedValue({ learned: [], partial: [], truncatedAt500: false })
  })

  it('emits path_requested first then path_returned with numeric latencyMs', async () => {
    kgQuery.mockResolvedValue({ response: emptyJson(), headers: '', latencyMs: 8 })

    const tel = makeTelemetry()
    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'cap-getting-started', fromSlug: 'abap-intro' },
      user: null,
      telemetry: tel,
    })

    expect(tel.emitted).toHaveLength(2)
    expect(tel.emitted[0].event).toBe('kg.joule.path_requested')
    expect(tel.emitted[1].event).toBe('kg.joule.path_returned')
    expect(typeof tel.emitted[1].payload.latencyMs).toBe('number')
    expect(tel.emitted[1].payload.latencyMs).toBeGreaterThanOrEqual(0)
  })

  it('emits path_returned with error:"timeout" on SparqlTimeoutError', async () => {
    const { SparqlTimeoutError: TimeoutErr } = await import('../../srv/lib/kg-sparql-client.js')
    kgQuery.mockRejectedValue(new TimeoutErr('timed out'))

    const tel = makeTelemetry()
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'cap-getting-started', fromSlug: 'abap-intro' },
      user: null,
      telemetry: tel,
    })

    expect(result).toMatch(/timed out/i)
    const returned = tel.emitted.find(e => e.event === 'kg.joule.path_returned')
    expect(returned).toBeDefined()
    expect(returned.payload.error).toBe('timeout')
  })
})
