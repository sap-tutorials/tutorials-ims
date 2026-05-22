const { cpSync, mkdirSync } = require('fs')
const { join } = require('path')

const DIST = join(__dirname, '..', 'dist')
const COMPONENTS_DIR = join(DIST, 'components')
const ADMIN_DIR = join(__dirname, '..', '..', 'admin')

const COMPONENTS = [
  'events',
  'missions',
  'groups',
  'tutorials',
  'tags',
  'accomplishments',
  'prizes',
  'operations',
  'accounts',
  'changelog',
  'analytics',
  'joule',
  'feedback'
]

mkdirSync(COMPONENTS_DIR, { recursive: true })

for (const name of COMPONENTS) {
  const src = join(ADMIN_DIR, name, 'webapp')
  const dest = join(COMPONENTS_DIR, name)
  cpSync(src, dest, { recursive: true })
  console.log(`  Copied ${name}`)
}

console.log(`\nAll ${COMPONENTS.length} components copied to dist/components/`)
