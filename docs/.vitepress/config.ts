import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'SAP Tutorials Platform',
  description: 'The platform behind developers.sap.com — for readers, authors, and engineers.',
  base: '/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'auto',

  // Map README.md → index.html so persona landing URLs (/end-users/, /authors/, …)
  // and the site root (/) resolve. VitePress does not do this rewrite by default.
  rewrites: {
    'README.md': 'index.md',
    'end-users/README.md': 'end-users/index.md',
    'authors/README.md': 'authors/index.md',
    'developers/README.md': 'developers/index.md',
    'historic/README.md': 'historic/index.md',
    'postmortems/README.md': 'postmortems/index.md'
  },

  ignoreDeadLinks: [
    // Project-source files (outside docs/ srcDir) — referenced for context
    // by developer docs but never resolvable as VitePress pages.
    // Patterns cover links of the form ./../../../<dir> and ../../../<dir>
    // used across developers/, historic/, and authors/ pages.
    /\.\.\/\.\.\/(hugo|hugo-apps|app|srv|db|db-qa|approuter|scripts|test|\.github|AGENTS)/,
    /\.\.\/\.deploy\//,
    /\.\.\/(hugo|test)\/(layouts|assets|static|content|hugo\.toml|a11y)/,
    /\.\.\/(hugo|test)$/,
    // superpowers/** is excluded from srcExclude (build), so links into it
    // from developer docs are not resolvable as VitePress pages.
    /\.\.\/\.\.\/superpowers\//,
    // TODO(#258 follow-up): docs/developers/architecture/analytics-builder.md
    // is referenced from free-text-grader.md but doesn't exist yet.
    /\.\/analytics-builder/,
  ],

  srcExclude: ['improvements.md', 'TODO.md', 'pilot-status.md', 'superpowers/**'],

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preload', href: '/fonts/72-Regular.woff2', as: 'font', type: 'font/woff2', crossorigin: '' }],
    ['link', { rel: 'preload', href: '/fonts/72-Bold.woff2',    as: 'font', type: 'font/woff2', crossorigin: '' }]
  ],

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
    config(md) {
      // Escape {{ and }} inside inline code spans so Vue's template compiler
      // doesn't try to evaluate Hugo/Go template syntax as interpolations.
      const defaultCodeInline = md.renderer.rules.code_inline!;
      md.renderer.rules.code_inline = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        token.content = token.content
          .replace(/\{\{/g, '&#123;&#123;')
          .replace(/\}\}/g, '&#125;&#125;');
        return defaultCodeInline(tokens, idx, options, env, self);
      };
    }
  },

  themeConfig: {
    nav: [
      { text: 'End Users',  link: '/end-users/' },
      { text: 'Authors',    link: '/authors/' },
      { text: 'Developers', link: '/developers/' },
      { text: 'Historic',   link: '/historic/' }
    ],

    sidebar: {
      '/end-users/': [
        { text: 'End Users', items: [
          { text: 'Overview',                 link: '/end-users/' },
          { text: 'Getting started',          link: '/end-users/getting-started' },
          { text: 'Using Joule chat',         link: '/end-users/using-joule-chat' },
          { text: 'Progress and completions', link: '/end-users/progress-and-completions' },
          { text: 'Privacy and cookies',      link: '/end-users/privacy-and-cookies' },
          { text: 'Accessibility',            link: '/end-users/accessibility' },
          { text: 'Experimental features',   link: '/end-users/experimental-features' }
        ]}
      ],

      '/authors/': [
        { text: 'Authors', items: [
          { text: 'Overview',          link: '/authors/' },
          { text: 'Writing tutorials', link: '/authors/writing-tutorials' },
          { text: 'Repo / group owners', link: '/authors/repo-group-owners' },
          { text: 'Center admin',      link: '/authors/center-admin' },
          { text: 'Analytics admin',   link: '/authors/analytics-admin' }
        ]}
      ],

      '/developers/': [
        { text: 'Overview', items: [
          { text: 'Persona index',   link: '/developers/' },
          { text: 'Getting started', link: '/developers/getting-started' }
        ]},
        { text: 'Architecture', items: [
          { text: 'Authentication and authorization', link: '/developers/architecture/authentication' },
          { text: 'Build pipeline',                   link: '/developers/architecture/build' },
          { text: 'CAP backend',                      link: '/developers/architecture/cap-backend' },
          { text: 'Frontend apps',                    link: '/developers/architecture/frontend-apps' },
          { text: 'Joule chat',                       link: '/developers/architecture/joule' },
          { text: '@PersonalData cascade',            link: '/developers/architecture/anonymization-cascade' },
          { text: 'Runtime',                          link: '/developers/architecture/runtime' },
          { text: 'Validation widget',                link: '/developers/architecture/validation-widget' },
          { text: 'Free-text grader',                 link: '/developers/architecture/free-text-grader' },
          { text: 'AI-authored quizzes',              link: '/developers/architecture/ai-authored-quizzes' }
        ]},
        { text: 'Operations', items: [
          { text: 'A/B comparison runbook',    link: '/developers/operations/ab-comparison-runbook' },
          { text: 'Deployment',                link: '/developers/operations/deployment' },
          { text: 'GitHub App setup',          link: '/developers/operations/github-app-setup' },
          { text: 'GitHub dispatch PAT rotation', link: '/developers/operations/github-dispatch-pat-rotation' },
          { text: 'HDI deploy checklist',      link: '/developers/operations/hdi-deploy-checklist' },
          { text: 'IAS setup',                 link: '/developers/operations/ias-setup' },
          { text: 'Joule chat admin settings', link: '/developers/operations/joule-chat-admin-settings' },
          { text: 'MTA deployment',            link: '/developers/operations/mta-deployment' },
          { text: 'Postmortems', collapsed: true, items: [
            { text: 'Overview',                  link: '/postmortems/' },
            { text: '2026-06-05 HDI Data Loss',  link: '/postmortems/2026-06-05-hdi-data-loss' }
          ]},
          { text: 'Production readiness',      link: '/developers/operations/production-ready' },
          { text: 'QA channel bootstrap',      link: '/developers/operations/qa-channel-bootstrap' },
          { text: 'Testing endpoints',         link: '/developers/operations/testing-endpoints' },
          { text: 'Testing guide',             link: '/developers/operations/testing-guide' },
          { text: 'Tutorial markdown lint',    link: '/developers/operations/tutorial-markdown-lint' }
        ]},
        { text: 'Reference', collapsed: true, items: [
          { text: 'AI-friendly consumption',   link: '/developers/reference/ai-consumption' },
          { text: 'Cookie and storage analysis', link: '/developers/reference/cookie-and-storage-analysis' },
          { text: 'Design decisions',          link: '/developers/reference/design-decisions' },
          { text: 'External integrations',     link: '/developers/reference/external-integrations' },
          { text: 'Sage extension migration',  link: '/developers/reference/sage-extension-migration' },
          { text: 'Theme variants',            link: '/developers/reference/theme-variants' }
        ]}
      ],

      '/historic/': [
        { text: 'Historic', items: [
          { text: 'Overview',                        link: '/historic/' },
          { text: 'AEM current state',               link: '/historic/aem-current-state' },
          { text: 'AEM gap analysis',                link: '/historic/aem-gap-analysis' },
          { text: 'Data migration',                  link: '/historic/data-migration' },
          { text: 'Decommissioned tasks',            link: '/historic/decommissioned-tasks' },
          { text: 'GitHub App migration',            link: '/historic/github-app-migration' },
          { text: 'Hugo migration',                  link: '/historic/hugo-migration' },
          { text: 'IMS API reference',               link: '/historic/ims-api-reference' },
          { text: 'IMS uncovered features',          link: '/historic/ims-uncovered-features' },
          { text: 'VitePress 2.x upgrade assessment', link: '/historic/vitepress-2x-upgrade-assessment' }
        ]}
      ]
    },

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/sap-tutorials/tutorials-ims/edit/main/docs/:path',
      text: 'Suggest an edit on GitHub'
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sap-tutorials/tutorials-ims' }
    ]
  }
});
