import { cpSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const staticDir = resolve(root, 'approuter/static')
const vitepressDist = resolve(root, 'site/.vitepress/dist')
const displayDist = resolve(root, 'display-app/dist')

if (existsSync(staticDir)) {
  rmSync(staticDir, { recursive: true })
}
mkdirSync(staticDir, { recursive: true })

cpSync(vitepressDist, staticDir, { recursive: true })
cpSync(displayDist, resolve(staticDir, 'display-app'), { recursive: true })

console.log('Copied VitePress dist + display-app dist → approuter/static/')
