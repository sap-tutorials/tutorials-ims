const { cpSync, mkdirSync, rmSync, existsSync, writeFileSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const DIST = join(ROOT, 'dist')
const DEPLOY = join(ROOT, 'deploy')
const RESOURCES = join(DEPLOY, 'resources', 'saptutorialsadminshell')

if (!existsSync(DIST)) {
  console.error('Error: dist/ not found. Run "npm run build" first.')
  process.exit(1)
}

if (existsSync(DEPLOY)) rmSync(DEPLOY, { recursive: true })
mkdirSync(RESOURCES, { recursive: true })

writeFileSync(join(DEPLOY, 'package.json'), JSON.stringify({
  name: 'tutorials-admin-ui-deployer',
  version: '0.0.1',
  scripts: { start: 'node node_modules/@sap/html5-app-deployer/index.js' },
  dependencies: { '@sap/html5-app-deployer': '^6' }
}, null, 2) + '\n')

cpSync(DIST, RESOURCES, { recursive: true })
console.log('Deployer package created at deploy/')
