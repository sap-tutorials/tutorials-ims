# VitePress 2.x Upgrade Assessment

> **Date:** 2026-04-27
> **Current version:** VitePress 1.6.4 (vite 5.4.21, esbuild 0.21.5)
> **Target version:** VitePress 2.0.0 (currently alpha.17, not yet GA)
> **Decision:** Wait for GA release before upgrading

## Motivation

Two medium-severity Dependabot alerts exist on transitive dependencies pinned by VitePress 1.6.x:

| Alert | Package | Vulnerable | Patched | CVE | Summary |
|-------|---------|-----------|---------|-----|---------|
| #1 | esbuild | <= 0.24.2 | 0.25.0 | — | Dev server sets `Access-Control-Allow-Origin: *`, allowing any website to read served content (GHSA-67mh-4wv8-2f99) |
| #2 | vite | <= 6.4.1 | 6.4.2 | CVE-2026-39365 | Path traversal in `.map` handling lets attacker read files outside project root when dev server is network-exposed (GHSA-4w7w-66w2-5vf9) |

Both are **dev-server-only** vulnerabilities — they do not affect the production build or the BTP Cloud Foundry deployment. VitePress 2.x pulls in vite ^7.3.1 which resolves both.

## VitePress 2.x Dependency Changes

| Dependency | 1.6.x | 2.0.0-alpha.17 |
|------------|-------|-----------------|
| vite | ^5.x | ^7.3.1 |
| vue | ^3.4 | ^3.5.27 |
| shiki | ^1.x | ^3.22.0 |
| @vitejs/plugin-vue | ^5.x | ^6.0.4 |

## Project VitePress Usage Summary

The project uses these VitePress APIs:

- **`defineConfig()`** — site config in `site/.vitepress/config.ts`
- **`DefaultTheme`** — imported from `vitepress/theme`, extended in `site/.vitepress/theme/index.ts`
- **`useData()`** — used in 7 components for `frontmatter` and `isDark`
- **`Content`** — renders markdown in `TutorialLayout.vue`
- **`enhanceApp()`** — registers 5 global Vue components (TutorialStep, OptionTabs, TutorialList, TutorialNavigator, AppSpace)
- **Custom `Layout` function** — switches between TutorialLayout, MissionLayout, GroupLayout, and DefaultTheme.Layout based on frontmatter `layout` field

The project does **not** use: `useRoute`, `useRouter`, `useLocalNav`, `useSidebar`, custom markdown-it plugins, Shiki transformers, DocSearch, `pathname://` protocol, or `@include` syntax.

## Breaking Changes Impact Analysis

### Low Risk (likely no action needed)

| Change | Why low risk |
|--------|-------------|
| `defineConfig()` API | Unchanged in 2.x |
| `useData()` composable | Return type and properties (`frontmatter`, `isDark`) still available |
| `DefaultTheme` import path | `vitepress/theme` still valid |
| Custom Layout function pattern | Still supported |
| `enhanceApp()` hook + `app.component()` | Signature unchanged |
| `Content` component | Still available |
| Vue components in markdown | Still works (`<TutorialStep>`, `<OptionTabs>`, etc.) |
| Vite proxy config | `server.proxy` carried forward to Vite 7 |
| SSR guards (`typeof window`) | Standard pattern, unaffected |
| `provide`/`inject`, `Teleport`, `<script setup>` | Standard Vue 3 Composition API, unaffected |
| `pathname://` protocol removed | Not used in this project |
| DocSearch v4 upgrade | Not used in this project |
| CJK emphasis option renamed | Not configured |
| Include error handling change | `@include` syntax not used |

### Medium Risk (test during upgrade)

| Change | Concern | Action |
|--------|---------|--------|
| **CSS class removals** — `vp-code` and `vp-adaptive-theme` classes removed | `sap-fundamental.css` bridges VitePress CSS tokens (`--vp-c-*`) to SAP Horizon tokens. Check if any selectors target removed classes. | Grep styles for `.vp-code` and `.vp-adaptive-theme`; update selectors to `.shiki` / `pre.shiki` / `[class*='language-']` |
| **`useLocalNav` / `useSidebar` removed** → replaced by `useLayout` | Not imported directly, but default theme sidebar behavior may change | Test tutorial sidebar TOC rendering |
| **Shiki v1 → v3** | Code block syntax highlighting engine upgraded | Test code blocks in tutorials for visual regressions |
| **Default theme styles markdown in home pages** | `index.md` uses `layout: page` with `<TutorialNavigator />` | If unwanted styles appear, add `markdownStyles: false` to frontmatter |
| **`system-ui` font removed** from `font-family-base` | Project overrides fonts with SAP 72 | Likely no impact, but verify font rendering |

## Upgrade Checklist

When VitePress 2.0 reaches GA:

- [ ] Read the official VitePress 1.x → 2.x migration guide
- [ ] Bump `vitepress` in `package.json`, run `npm install`
- [ ] Grep `sap-fundamental.css` and scoped styles for `.vp-code`, `.vp-adaptive-theme` — update selectors
- [ ] Run `npm run build` and fix any build errors
- [ ] Test all layout types: tutorial, mission, group, page (index), app-space
- [ ] Test `<TutorialStep>` accordion expand/collapse and Done button
- [ ] Test `<OptionTabs>` tab switching
- [ ] Test TutorialNavigator search and filter cards
- [ ] Test dark mode toggle (`isDark` from `useData()`)
- [ ] Test dev server proxy (`/api/*` → CAP backend, `/bin/sapdx/*` → developers.sap.com)
- [ ] Test code block rendering in tutorial steps (Shiki v3)
- [ ] Test `FeedbackShareBar` Teleport modals
- [ ] Verify SAP Fundamental Styles / Horizon theme CSS variables still bridge correctly
- [ ] Confirm both Dependabot alerts are resolved by checking `npm ls vite esbuild`
- [ ] Run `npm run test` and fix any test failures

## Files to Inspect During Upgrade

| File | Why |
|------|-----|
| `site/.vitepress/config.ts` | VitePress + Vite config |
| `site/.vitepress/theme/index.ts` | Theme registration, Layout function, enhanceApp |
| `site/.vitepress/theme/styles/sap-fundamental.css` | CSS variable bridge, may reference removed classes |
| `site/.vitepress/theme/styles/sap-horizon-dark-scoped.css` | Dark theme scoped styles |
| `site/.vitepress/theme/components/TutorialLayout.vue` | Largest layout (~640 lines), uses `useData`, `Content`, `provide`/`inject` |
| `site/.vitepress/theme/components/MissionLayout.vue` | Uses `useData`, AEM enrichment |
| `site/.vitepress/theme/components/GroupLayout.vue` | Uses `useData` |
| `site/.vitepress/theme/components/AppSpace.vue` | Uses `isDark` from `useData` |
| `site/.vitepress/theme/components/FeedbackShareBar.vue` | Uses `Teleport`, SSR guard |
