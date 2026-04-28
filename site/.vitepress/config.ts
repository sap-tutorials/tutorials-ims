import { defineConfig } from 'vitepress'
import type { Plugin } from 'vite'

const COMPONENT_TAGS = new Set([
  'TutorialStep', 'OptionTabs', 'ClientOnly',
  'Content', 'VPBadge', 'VPTeamPage', 'VPTeamMembers',
])

function tutorialAssetFallback(): Plugin {
  return {
    name: 'tutorial-asset-fallback',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer?.includes('/tutorials/') && source.startsWith('./assets/')) {
        return { id: '\0tutorial-missing-asset', external: false }
      }
    },
    load(id) {
      if (id === '\0tutorial-missing-asset') {
        return 'export default ""'
      }
    },
  }
}

export default defineConfig({
  title: 'SAP Tutorial Platform POC',
  description: 'Tutorials powered by VitePress on SAP BTP',
  srcDir: '.',
  outDir: '.vitepress/dist',
  ignoreDeadLinks: true,
  appearance: 'auto',

  themeConfig: {
    nav: [
      { text: 'Tutorials', link: '/' },
      { text: 'App Space', link: '/app-space' },
      { text: 'Event Display', link: '/event-display' },
    ],
  },

  markdown: {
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
  },

  vite: {
    plugins: [tutorialAssetFallback()],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:4004',
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/api/, ''),
        },
        '/bin/sapdx': {
          target: 'https://developers.sap.com',
          changeOrigin: true,
          secure: true,
        },
      },
    },
  },
})
