import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'SAP Tutorials Platform',
  description: 'The platform behind developers.sap.com — for readers, authors, and engineers.',
  // GitHub Pages serves this site at https://sap-tutorials.github.io/tutorials-ims/
  // The trailing-slash project base is required so VitePress prefixes generated
  // bundle URLs (/assets/*) and router links (sidebar/nav) under the repo path.
  base: '/tutorials-ims/',
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
    'postmortems/README.md': 'postmortems/index.md',
    'decisions/README.md': 'decisions/index.md'
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
    /\.\.\/superpowers\//,
    // decisions/_template.md is srcExcluded (template, not a page).
    /\.\/_template/,
    // TODO(#258 follow-up): docs/developers/architecture/analytics-builder.md
    // is referenced from free-text-grader.md but doesn't exist yet.
    /\.\/analytics-builder/,
  ],

  srcExclude: ['improvements.md', 'TODO.md', 'pilot-status.md', 'superpowers/**', 'decisions/_template.md'],

  // Paths in `head[]` are passed through verbatim — VitePress does not
  // apply `base` here. Relative paths resolve against the current page URL
  // (which breaks on deep routes like /end-users/getting-started), so the
  // `base` prefix is included explicitly. Update both this and `base` above
  // if the repo is ever renamed.
  head: [
    ['link', { rel: 'icon', href: '/tutorials-ims/favicon.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preload', href: '/tutorials-ims/fonts/72-Regular.woff2', as: 'font', type: 'font/woff2', crossorigin: '' }],
    ['link', { rel: 'preload', href: '/tutorials-ims/fonts/72-Bold.woff2',    as: 'font', type: 'font/woff2', crossorigin: '' }]
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
      { text: '🚀 Launch',  link: '/launch' },
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
          { text: 'Experimental features',   link: '/end-users/experimental-features' },
          { text: 'Your profile page',        link: '/end-users/me-page' }
        ]}
      ],

      '/authors/': [
        { text: 'Authors', items: [
          { text: 'Overview',          link: '/authors/' },
          { text: 'Writing tutorials', link: '/authors/writing-tutorials' },
          { text: 'Repo / group owners', link: '/authors/repo-group-owners' },
          { text: 'Center admin',      link: '/authors/center-admin' },
          { text: 'Analytics admin',   link: '/authors/analytics-admin' }
        ]},
        { text: 'Branching paths', items: [
          { text: 'Branched missions',  link: '/authors/branched-missions' },
          { text: 'Branched tutorials', link: '/authors/branched-tutorials' },
          { text: 'Branching cookbook', link: '/authors/branching-cookbook' },
          { text: 'Reading branch telemetry', link: '/authors/reading-branch-telemetry' },
          { text: 'Pilot runbook',     link: '/authors/pilot-runbook' }
        ]},
        { text: 'Operations', items: [
          { text: 'Scheduling alerts', link: '/authors/operations/scheduling-alerts' }
        ]}
      ],

      '/developers/': [
        { text: 'Overview', items: [
          { text: 'Persona index',   link: '/developers/' },
          { text: 'Getting started', link: '/developers/getting-started' }
        ]},
        { text: 'Architecture', items: [
          { text: 'Authentication and authorization', link: '/developers/architecture/authentication' },
          { text: 'AuthorService',                    link: '/developers/architecture/author-service' },
          { text: 'Build pipeline',                   link: '/developers/architecture/build' },
          { text: 'CAP backend',                      link: '/developers/architecture/cap-backend' },
          { text: 'Frontend apps',                    link: '/developers/architecture/frontend-apps' },
          { text: 'Homepage',                         link: '/developers/architecture/homepage' },
          { text: 'Homepage explainer popovers',      link: '/developers/architecture/homepage-explainers' },
          { text: 'Joule chat',                       link: '/developers/architecture/joule' },
          { text: 'Joule aurora background',          link: '/developers/architecture/joule-aurora' },
          { text: '@PersonalData cascade',            link: '/developers/architecture/anonymization-cascade' },
          { text: 'Runtime',                          link: '/developers/architecture/runtime' },
          { text: 'Validation widget',                link: '/developers/architecture/validation-widget' },
          { text: 'Free-text grader',                 link: '/developers/architecture/free-text-grader' },
          { text: 'AI-authored quizzes',              link: '/developers/architecture/ai-authored-quizzes' },
          { text: 'Categories classifier',            link: '/developers/architecture/categories-classifier' },
          { text: 'Developer Advocates',              link: '/developers/architecture/advocates' },
          { text: 'HANA KG Engine access',            link: '/developers/architecture/hana-kge-access' },
          { text: 'Khoros community link',            link: '/developers/architecture/khoros-link' },
          { text: 'Scaling playbook',                 link: '/developers/architecture/scaling-playbook' }
        ]},
        { text: 'Operations', items: [
          { text: 'A/B comparison runbook',    link: '/developers/operations/ab-comparison-runbook' },
          { text: 'Advocate export/import',    link: '/developers/operations/advocate-export-import' },
          { text: 'Agent isolation hooks',     link: '/developers/operations/agent-isolation-hooks' },
          { text: 'AI-author CI setup',        link: '/developers/operations/ai-author-ci-setup' },
          { text: 'BTP destinations (SCI / NGDS)', link: '/developers/operations/btp-destinations' },
          { text: 'BTP role migration',        link: '/developers/operations/btp-role-migration' },
          { text: 'Dedupe Step rows',          link: '/developers/operations/dedupe-step-rows' },
          { text: 'Migration from IMS',        link: '/developers/operations/migration-from-ims' },
          { text: 'Deployment',                link: '/developers/operations/deployment' },
          { text: 'GitHub App setup',          link: '/developers/operations/github-app-setup' },
          { text: 'GitHub dispatch PAT rotation', link: '/developers/operations/github-dispatch-pat-rotation' },
          { text: 'HDI deploy checklist',      link: '/developers/operations/hdi-deploy-checklist' },
          { text: 'IAS setup',                 link: '/developers/operations/ias-setup' },
          { text: 'Joule chat admin settings', link: '/developers/operations/joule-chat-admin-settings' },
          { text: 'KG concept operations',     link: '/developers/operations/kg-concept-operations' },
          { text: 'KG grantor setup',          link: '/developers/operations/kg-grantor-setup' },
          { text: 'Live probing',              link: '/developers/operations/live-probing' },
          { text: 'MTA deployment',            link: '/developers/operations/mta-deployment' },
          { text: 'Phase 4 code-check eval',   link: '/developers/operations/phase-4-codecheck-eval' },
          { text: 'Postmortems', collapsed: true, items: [
            { text: 'Overview',                  link: '/postmortems/' },
            { text: '2026-06-05 HDI Data Loss',  link: '/postmortems/2026-06-05-hdi-data-loss' }
          ]},
          { text: 'Production readiness',      link: '/developers/operations/production-ready' },
          { text: 'QA channel bootstrap',      link: '/developers/operations/qa-channel-bootstrap' },
          { text: 'Re-migration runbook',      link: '/developers/operations/re-migration-runbook' },
          { text: 'Rebuild content workflow',  link: '/developers/operations/rebuild-content-workflow' },
          { text: 'Content rollback',          link: '/developers/operations/content-rollback' },
          { text: 'Runtime config',            link: '/developers/operations/runtime-config' },
          { text: 'Secrets tracking',          link: '/developers/operations/secrets-tracking' },
          { text: 'SMTP credentials rotation', link: '/developers/operations/smtp-credentials-rotation' },
          { text: 'Testing endpoints',         link: '/developers/operations/testing-endpoints' },
          { text: 'Testing guide',             link: '/developers/operations/testing-guide' },
          { text: 'Tutorial markdown lint',    link: '/developers/operations/tutorial-markdown-lint' }
        ]},
        { text: 'Reference', collapsed: true, items: [
          { text: 'AI-friendly consumption',   link: '/developers/reference/ai-consumption' },
          { text: 'Architecture decisions (ADR)', collapsed: true, items: [
            { text: 'Overview',                          link: '/decisions/' },
            { text: '0001 — Tutorial HTML in HANA',      link: '/decisions/0001-tutorial-html-in-hana-not-static' },
            { text: '0002 — QA channel as parallel srv', link: '/decisions/0002-qa-channel-parallel-srv' },
            { text: '0003 — Public Hugo, lazy login',    link: '/decisions/0003-public-hugo-lazy-login' },
            { text: '0004 — JWT-only identity',          link: '/decisions/0004-jwt-only-identity' },
            { text: '0005 — bootstrap vs served split',  link: '/decisions/0005-bootstrap-vs-served-split' }
          ]},
          { text: 'CAP / CDS gotchas',         link: '/developers/reference/cap-cds-gotchas' },
          { text: 'Cookie and storage analysis', link: '/developers/reference/cookie-and-storage-analysis' },
          { text: 'Design decisions',          link: '/developers/reference/design-decisions' },
          { text: 'External integrations',     link: '/developers/reference/external-integrations' },
          { text: 'HANA / HDI / SQL gotchas',  link: '/developers/reference/hana-hdi-gotchas' },
          { text: 'Iframe allowlist',          link: '/developers/reference/iframe-allowlist' },
          { text: 'Sage extension migration',  link: '/developers/reference/sage-extension-migration' },
          { text: 'Theme variants',            link: '/developers/reference/theme-variants' },
          { text: 'Vue islands / Hugo / Vite gotchas', link: '/developers/reference/vue-islands-gotchas' }
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
