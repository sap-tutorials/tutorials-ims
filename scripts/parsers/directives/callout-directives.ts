// scripts/parsers/directives/callout-directives.ts
//
// Registers five container callout directives (details, troubleshoot, result,
// hint, solution) and one inline directive (spoiler) in the global directive
// registry.  This module is a side-effect import — simply importing it populates
// the registry.  Wire it in compose.ts.
//
// registerCalloutDirectives() is also exported for test use: tests that call
// resetRegistry() between cases can call this to repopulate the registry
// without relying on module re-import (ES modules are cached after first load).
import { registerDirective } from '../directive-registry.js'
import type { DirectiveNode } from '../directives.js'

const COLLAPSIBLE = new Set(['details', 'troubleshoot', 'hint', 'solution'])

function makeCalloutContainer(reg: typeof registerDirective, name: string, since = '1.1.0') {
  reg({
    name,
    kinds: ['container'],
    summary: `Collapsible ${name} callout (rendered via tut-alert shortcode)`,
    label: { required: name === 'details', markdown: false },
    attrs: COLLAPSIBLE.has(name) ? { open: { type: 'boolean', default: false } } : {},
    classes: [],
    render(node: DirectiveNode) {
      const params: Record<string, string | boolean> = { type: name }
      if (node.label) params.title = node.label
      if (node.attrs.open) params.open = true
      return { params, body: node.body ?? '' }
    },
    toText(node: DirectiveNode) {
      const title = node.label ? ` ${node.label}` : ''
      return `**${name.charAt(0).toUpperCase() + name.slice(1)}:${title}**\n\n${node.body ?? ''}`
    },
    since,
  })
}

export function registerCalloutDirectives(): void {
  ;(['details', 'troubleshoot', 'result', 'hint', 'solution'] as const).forEach(
    (name) => makeCalloutContainer(registerDirective, name),
  )

  registerDirective({
    name: 'spoiler',
    kinds: ['inline'],
    summary: 'Inline spoiler text revealed on click/keyboard',
    label: { required: true, markdown: false },
    attrs: {},
    classes: [],
    render(node: DirectiveNode) {
      return { params: { text: node.label ?? '' } }
    },
    toText(node: DirectiveNode) {
      return `||${node.label ?? ''}||`
    },
    since: '1.1.0',
  })
}

// Side-effect registration: runs once on first import.
registerCalloutDirectives()
