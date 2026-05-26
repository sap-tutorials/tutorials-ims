import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'SAP Tutorials Platform',
  description: 'The platform behind developers.sap.com — for readers, authors, and engineers.',
  base: '/tutorials-poc/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'auto',

  srcExclude: ['improvements.md', 'TODO.md', 'pilot-status.md', 'superpowers/**'],

  head: [
    ['link', { rel: 'icon', href: '/tutorials-poc/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preload', href: '/tutorials-poc/fonts/72-Regular.woff2', as: 'font', type: 'font/woff2', crossorigin: '' }],
    ['link', { rel: 'preload', href: '/tutorials-poc/fonts/72-Bold.woff2',    as: 'font', type: 'font/woff2', crossorigin: '' }]
  ],

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' }
  },

  themeConfig: {
    nav: [
      { text: 'End Users',  link: '/end-users/' },
      { text: 'Authors',    link: '/authors/' },
      { text: 'Developers', link: '/developers/' },
      { text: 'Historic',   link: '/historic/' }
    ],

    sidebar: {
      '/end-users/':  [{ text: 'End Users',  items: [{ text: 'Overview', link: '/end-users/' }] }],
      '/authors/':    [{ text: 'Authors',    items: [{ text: 'Overview', link: '/authors/' }] }],
      '/developers/': [{ text: 'Developers', items: [{ text: 'Overview', link: '/developers/' }] }],
      '/historic/':   [{ text: 'Historic',   items: [{ text: 'Overview', link: '/historic/' }] }]
    },

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/sap-tutorials/tutorials-poc/edit/main/docs/:path',
      text: 'Suggest an edit on GitHub'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sap-tutorials/tutorials-poc' }
    ]
  }
});
