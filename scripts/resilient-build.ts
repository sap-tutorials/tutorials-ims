#!/usr/bin/env tsx
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TUTORIALS_DIR = join(ROOT, 'site', 'tutorials')
const QUARANTINE_DIR = join(ROOT, '.tutorial-cache', 'quarantine')

const MAX_RETRIES = 100
const quarantined: Array<{ file: string; error: string }> = []

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  try {
    const result = execFileSync('npx', ['vitepress', 'build', 'site'], {
      cwd: ROOT,
      stdio: 'pipe',
      timeout: 600_000,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    })
    console.log('Build succeeded!')
    break
  } catch (err: unknown) {
    const stderr = ((err as { stderr?: Buffer }).stderr?.toString() ?? '')
    const stdout = ((err as { stdout?: Buffer }).stdout?.toString() ?? '')
    const output = stderr + stdout

    const fileMatch = output.match(/site\/tutorials\/([a-z0-9_-]+\.md)/i)
    if (!fileMatch) {
      console.error(`Build failed (attempt ${attempt}) with non-tutorial error:`)
      console.error(output.slice(-800))
      process.exit(1)
    }

    const failingFile = fileMatch[1]
    const errorMatch = output.match(/\): (.+)/)
    const errorMsg = errorMatch ? errorMatch[1].trim() : 'Unknown error'

    console.log(`[${attempt}] Quarantining: ${failingFile} — ${errorMsg}`)
    quarantined.push({ file: failingFile, error: errorMsg })

    const src = join(TUTORIALS_DIR, failingFile)
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    if (existsSync(src)) {
      renameSync(src, join(QUARANTINE_DIR, failingFile))
    }
  }
}

if (quarantined.length > 0) {
  const remaining = readdirSync(TUTORIALS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_')).length

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`BUILD COMPLETE`)
  console.log(`  ${remaining} tutorials built successfully`)
  console.log(`  ${quarantined.length} tutorials quarantined:`)
  for (const q of quarantined) {
    console.log(`    ✗ ${q.file}: ${q.error}`)
  }
  console.log('─'.repeat(60))

  const logPath = join(QUARANTINE_DIR, 'errors.json')
  writeFileSync(logPath, JSON.stringify(quarantined, null, 2), 'utf-8')
}
