import { createApp } from 'vue'
import MyCompletions from './MyCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'

// IMPORTANT: do NOT import "@ui5/webcomponents/*" or "@ui5/webcomponents-fiori/*"
// from this entry. Direct imports here force Vite to bundle a SECOND, independent
// copy of UI5 Web Components into me.js — each copy has its own module-scoped
// Theme state, so setTheme() in ui5-bootstrap.ts only flips its own copy and
// the me.js copy stays stuck on the default sap_horizon (light) theme. Result:
// dark-on-dark text in the nav popover items AND in the /me page content (the
// "Learning preferences" ui5-title, ui5-label rows, ui5-text, etc.). See
// PR #627 / #575 / [[feedback_ui5_settheme_race_with_vue_islands]] — those
// shipped a "race" fix that doesn't apply here. The real fix: register every
// UI5 component this island uses in hugo/assets/js/ui5-bootstrap.ts so they
// boot under that shared UI5 copy. A regression guard runs in
// scripts/check-island-ui5-imports.cjs (postbuild:apps).
//
// Components used on /me/ (all registered in ui5-bootstrap.ts):
//   Title, Select, Option, MessageStrip, Button, Label, Text, Timeline, TimelineItem

const myCompletionsEl = document.getElementById('me-completions')
if (myCompletionsEl) createApp(MyCompletions).mount(myCompletionsEl)

const learningPrefsEl = document.getElementById('me-learning-preferences')
if (learningPrefsEl) createApp(LearningPreferences).mount(learningPrefsEl)
