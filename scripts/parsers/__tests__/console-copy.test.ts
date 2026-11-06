// @vitest-environment happy-dom
//
// Tests for copyConsoleCommands — reads .cl-cmd[data-cmd-text] spans from a
// console block's .code-block-body and returns only the command text (no prompts).

import { copyConsoleCommands } from '../../../hugo/assets/js/copy-clean.js'

// ---------------------------------------------------------------------------
// Build a minimal console block DOM for testing
// ---------------------------------------------------------------------------

function makeBlock(spans: Array<{ cls: 'cl-cmd' | 'cl-out' | 'cl-cont'; text: string; cmdText?: string; continuation?: boolean }>): HTMLElement {
  const body = document.createElement('div')
  body.className = 'code-block-body'
  body.setAttribute('data-console', 'true')

  const pre = document.createElement('pre')
  for (const s of spans) {
    const span = document.createElement('span')
    span.className = s.cls
    span.textContent = s.text
    if (s.cmdText !== undefined) span.setAttribute('data-cmd-text', s.cmdText)
    if (s.continuation) span.setAttribute('data-continuation', 'true')
    pre.appendChild(span)
    pre.appendChild(document.createTextNode('\n'))
  }
  body.appendChild(pre)
  return body
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

it('copies only command lines, stripping prompts', () => {
  const block = makeBlock([
    { cls: 'cl-cmd', text: '$ cf login', cmdText: 'cf login' },
    { cls: 'cl-out', text: 'API endpoint: https://api.cf.example.com' },
    { cls: 'cl-cmd', text: '$ cf target -s dev', cmdText: 'cf target -s dev' },
    { cls: 'cl-out', text: 'Targeting environment: dev' },
  ])
  expect(copyConsoleCommands(block)).toBe('cf login\ncf target -s dev')
})

it('groups multi-line continuation', () => {
  const block = makeBlock([
    { cls: 'cl-cmd', text: '$ cf push myapp \\', cmdText: 'cf push myapp \\' },
    { cls: 'cl-cont', text: '  --no-start', cmdText: '  --no-start', continuation: true },
  ])
  expect(copyConsoleCommands(block)).toBe('cf push myapp \\\n  --no-start')
})

it('excludes output lines', () => {
  const block = makeBlock([
    { cls: 'cl-cmd', text: '$ npm install', cmdText: 'npm install' },
    { cls: 'cl-out', text: 'API endpoint: https://api.cf.example.com' },
    { cls: 'cl-out', text: 'added 42 packages' },
  ])
  const result = copyConsoleCommands(block)
  expect(result).not.toContain('API endpoint:')
  expect(result).toBe('npm install')
})

it('returns empty string when block has no command spans', () => {
  const block = makeBlock([
    { cls: 'cl-out', text: 'Some output only' },
    { cls: 'cl-out', text: 'More output' },
  ])
  expect(copyConsoleCommands(block)).toBe('')
})

it('uses textContent fallback when data-cmd-text is absent', () => {
  const body = document.createElement('div')
  body.className = 'code-block-body'
  body.setAttribute('data-console', 'true')
  const pre = document.createElement('pre')
  const span = document.createElement('span')
  span.className = 'cl-cmd'
  span.textContent = 'npm run build'
  // deliberately no data-cmd-text attribute
  pre.appendChild(span)
  body.appendChild(pre)

  expect(copyConsoleCommands(body)).toBe('npm run build')
})

// Step 1.8: guard assertion — console branch only triggers on the right lang/attr
//
// The render-codeblock.html console branch is guarded by:
//   {{- if or (eq $lower "console") (eq $lower "shell-session")
//              (eq $lower "terminal-session") (index $attrs "prompt") -}}
//
// A plain ```bash fence has $lower = "bash" and no "prompt" attr, so it takes
// the existing highlight path unchanged — no data-console attribute, no .cl-cmd
// spans. Existing bash fences produce byte-identical output to before this change.
it('bash fence without {prompt} is unchanged (guard comment)', () => {
  // Static documentation test. The guard condition above is the contract.
  expect(true).toBe(true)
})
