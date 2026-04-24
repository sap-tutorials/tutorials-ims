import { defineConfig } from 'vitepress'

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
    ],
  },

  vite: {
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
