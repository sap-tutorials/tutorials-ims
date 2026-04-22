import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const darkCssPath = join(__dirname, '..', 'node_modules', 'fundamental-styles', 'dist', 'theming', 'sap_horizon_dark.css')
const outputPath = join(__dirname, '..', 'site', '.vitepress', 'theme', 'styles', 'sap-horizon-dark-scoped.css')

const raw = readFileSync(darkCssPath, 'utf-8')

const varRegex = /--(sap|fd|btp)[A-Za-z0-9_-]+\s*:\s*[^;]+/g
const matches = raw.match(varRegex)

if (!matches || matches.length === 0) {
  console.error('No CSS variables found in dark theme file')
  process.exit(1)
}

const lines = matches.map(m => {
  let cleaned = m.replace(/\}+$/, '')
  const openParens = (cleaned.match(/\(/g) || []).length
  const closeParens = (cleaned.match(/\)/g) || []).length
  if (openParens > closeParens) {
    cleaned += ')'.repeat(openParens - closeParens)
  }
  return `  ${cleaned};`
})

const output = `/* Auto-generated from fundamental-styles sap_horizon_dark.css */
/* Run: npx tsx scripts/generate-dark-theme.ts to regenerate */

html.dark {
${lines.join('\n')}
}
`

mkdirSync(dirname(outputPath), { recursive: true })
writeFileSync(outputPath, output, 'utf-8')
console.log(`Wrote ${matches.length} variables to ${outputPath}`)
