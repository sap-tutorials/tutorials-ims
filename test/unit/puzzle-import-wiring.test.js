// test/unit/puzzle-import-wiring.test.js
//
// Regression for issue #1909 ("Puzzle is not importing").
//
// Root cause: the native <input type=file> behind the core:HTML #importFileInput
// only had its `change` listener attached in the controller's onAfterRendering.
// That input lives inside the edit-mode VBox (visible="{= mode === 'edit' }"), so
// on the initial (list-mode) render its DOM does not exist and no listener is
// wired. Clicking "Create New" re-renders only that VBox subtree via invalidation
// — the *view's* onAfterRendering does NOT re-fire — so the materialized <input>
// never gets a listener. onImportPress (fixed in #1834) opens the file dialog, the
// user picks a file, but the change event lands on an input with no listener, so
// onImportFile never runs → the import silently does nothing.
//
// This test loads the REAL Builder controller (with the real puzzle-io + geometry
// libs, UI5 framework deps stubbed) and drives the exact user path: enter edit
// mode with the file input freshly materialized (no prior onAfterRendering wiring),
// press Import, then fire a native `change`. It asserts onImportFile actually ran
// and imported the puzzle. Before the fix the import is a silent no-op and this
// fails; after the fix the change listener is wired by onImportPress and it passes.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'

const APP = path.resolve(__dirname, '../../app/admin/puzzles/webapp')

// Load a UI5 AMD module (sap.ui.define) with the given resolved dependencies.
// `globals` are merged into the module's realm — the controller's methods run in
// this realm, so browser globals it uses (FileReader) must live here.
function loadAmd(relPath, deps, globals) {
  const src = readFileSync(path.resolve(APP, relPath), 'utf8')
  let captured
  const sandbox = Object.assign(
    { sap: { ui: { define: (a, b) => { captured = typeof a === 'function' ? a : b } } } },
    globals || {}
  )
  vm.runInNewContext(src, sandbox)
  return captured(...(deps || []))
}

const geom = loadAmd('lib/crossword-geometry.js', [])
const io = loadAmd('lib/puzzle-io.js', [])

// A well-formed 5x5 puzzle (the exact shape attached to issue #1909: numeric
// STRING rows/cols, grid of {black, number} cells).
const PUZZLE = JSON.stringify({
  formatVersion: 1,
  rows: '5', cols: '5',
  grid: Array.from({ length: 5 }, () =>
    Array.from({ length: 5 }, () => ({ black: false, number: null }))),
  clues: { '0-0-across': 'Atop' },
  answers: { '0,0': 'A' },
  title: 'Warmup', slug: 'warmup-devtoberfest-2026'
})

// Minimal fake for the native <input type=file> that core:HTML renders. tagName
// is INPUT so _importInput() returns it directly (single-root-element case).
function makeFakeInput() {
  const listeners = {}
  return {
    tagName: 'INPUT',
    value: 'stale',
    clicked: 0,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn) },
    click() { this.clicked++ },
    // Simulate the browser dispatching a change after the user picks a file.
    fireChange(evt) { (listeners.change || []).forEach((fn) => fn(evt)) },
    _listenerCount() { return (listeners.change || []).length }
  }
}

// A minimal stand-in for a UI5 JSONModel (only the API onImportFile touches).
function makeModel(initial) {
  const data = Object.assign({}, initial)
  return {
    getProperty(p) { return data[p.replace(/^\//, '')] },
    setProperty(p, v) { data[p.replace(/^\//, '')] = v },
    _data: data
  }
}

// Build a controller instance from the real module with framework deps stubbed.
function makeController(fakeInput) {
  const toasts = []
  const errors = []
  const Controller = { extend: (_name, obj) => obj }
  const MessageToast = { show: (m) => toasts.push(m) }
  const MessageBox = { error: (m) => errors.push(m) }
  // FileReader stub: onImportFile does `new FileReader()`, sets `.onload`, then
  // `readAsText(file)`. Deliver the file's content synchronously.
  class FakeFileReader {
    readAsText(file) { this.onload({ target: { result: file._content } }) }
  }
  const proto = loadAmd('controller/Builder.controller.js', [
    Controller, /* JSONModel */ function () {}, MessageToast, MessageBox,
    /* Fragment */ {}, geom, io, /* solver */ {}, /* draftSave */ {}, /* odataBatch */ {}
  ], { FileReader: FakeFileReader })

  const model = makeModel({ mode: 'edit', grid: [], answers: {}, clues: {}, hints: {} })
  const ctrl = Object.assign(Object.create(proto), {
    byId: () => ({ getDomRef: () => fakeInput }),
    getView: () => ({ getModel: () => model }),
    // Rendering side-effects are out of scope for the wiring test — no-op them.
    _recomputeSlots() {},
    _renderGrid() {}
  })
  return { ctrl, model, toasts, errors }
}

describe('puzzle import wiring (issue #1909)', () => {
  it('onImportPress wires the change listener so a file selection actually imports', () => {
    const input = makeFakeInput()
    const { ctrl, model, toasts } = makeController(input)

    // User is in edit mode and clicks Import. The input DOM was just materialized
    // by the list→edit transition, so no onAfterRendering wiring happened.
    ctrl.onImportPress()

    // The dialog must have been opened with a cleared value...
    expect(input.clicked).toBe(1)
    expect(input.value).toBe('')
    // ...and a change listener must now be attached (the bug: it was not).
    expect(input._listenerCount()).toBeGreaterThan(0)

    // User picks the #1909 file; the browser fires `change`.
    input.fireChange({ target: { files: [{ /* FileReader stub reads _content */ _content: PUZZLE }] } })

    // onImportFile must have run and imported the puzzle into the model.
    expect(model.getProperty('/rows')).toBe(5)
    expect(model.getProperty('/cols')).toBe(5)
    expect(Array.isArray(model.getProperty('/grid'))).toBe(true)
    expect(model.getProperty('/grid').length).toBe(5)
    expect(model.getProperty('/slug')).toBe('warmup-devtoberfest-2026')
    expect(toasts).toContain('Puzzle imported')
  })
})
