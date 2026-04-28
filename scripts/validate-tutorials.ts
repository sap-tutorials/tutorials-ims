import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@vue/compiler-dom'
import { createMarkdownRenderer } from 'vitepress'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TUTORIALS_DIR = join(ROOT, 'site', 'tutorials')
const QUARANTINE_DIR = join(ROOT, '.tutorial-cache', 'quarantine')

const COMPONENT_TAGS = new Set([
  'TutorialStep', 'OptionTabs', 'ClientOnly',
  'Content', 'VPBadge', 'VPTeamPage', 'VPTeamMembers',
])

const md = await createMarkdownRenderer(join(ROOT, 'site'), {
  config(md) {
    const defaultRender = md.renderer.rules.html_block ??
      function(tokens: any[], idx: number) { return tokens[idx].content }

    md.renderer.rules.html_block = (tokens, idx, options, env, self) => {
      const content = tokens[idx].content
      const isComponent = /<\/?\s*([A-Z][A-Za-z0-9]*)/.test(content) &&
        COMPONENT_TAGS.has(content.match(/<\/?\s*([A-Z][A-Za-z0-9]*)/)?.[1] ?? '')
      if (isComponent) return defaultRender(tokens, idx, options, env, self)
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }

    const defaultInline = md.renderer.rules.html_inline ??
      function(tokens: any[], idx: number) { return tokens[idx].content }

    md.renderer.rules.html_inline = (tokens, idx, options, env, self) => {
      const content = tokens[idx].content
      const tagMatch = content.match(/<\/?\s*([A-Za-z][A-Za-z0-9]*)/)
      const tagName = tagMatch?.[1] ?? ''
      if (COMPONENT_TAGS.has(tagName)) return defaultInline(tokens, idx, options, env, self)
      return content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }
  },
}, '')

const files = readdirSync(TUTORIALS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('mission-') && !f.startsWith('group-'))

console.log(`Pre-validating ${files.length} tutorials (Vue template compilation)...\n`)

const quarantined: Array<{ file: string; reason: string }> = []

for (const file of files) {
  const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
  const fmMatch = content.match(/^---\n[\s\S]*?\n---\n?/)
  const body = fmMatch ? content.slice(fmMatch[0].length) : content

  try {
    const html = md.render(body, {})
    compile('<div>' + html + '</div>', {
      mode: 'module',
      onError(e) { throw e },
    })
  } catch (e: any) {
    const reason = e.message?.slice(0, 200) ?? 'Unknown compilation error'
    quarantined.push({ file, reason })
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    renameSync(join(TUTORIALS_DIR, file), join(QUARANTINE_DIR, file))
    console.log(`  ✗ ${file}: ${reason}`)
  }
}

if (quarantined.length > 0) {
  console.log(`\n${quarantined.length} tutorials quarantined`)
  const logPath = join(QUARANTINE_DIR, 'errors.json')
  writeFileSync(logPath, JSON.stringify(quarantined, null, 2), 'utf-8')
} else {
  console.log('All tutorials passed pre-validation')
}

console.log(`${files.length - quarantined.length} tutorials ready for build`)
