import { createApp } from 'vue'
import MyCompletions from './MyCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'

// U17: Recent Activity timeline on the profile page (existing).
import "@ui5/webcomponents-fiori/dist/Timeline.js";
import "@ui5/webcomponents-fiori/dist/TimelineItem.js";

// PR 6 — UI5 imports for LearningPreferences island. Per recon: all 7 are
// net-new for me.js. Bundle estimate ~20-30 kB gzip net add.
import "@ui5/webcomponents/dist/Select.js";
import "@ui5/webcomponents/dist/Option.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Label.js";
import "@ui5/webcomponents/dist/Title.js";
import "@ui5/webcomponents/dist/Text.js";

const myCompletionsEl = document.getElementById('me-completions')
if (myCompletionsEl) createApp(MyCompletions).mount(myCompletionsEl)

const learningPrefsEl = document.getElementById('me-learning-preferences')
if (learningPrefsEl) createApp(LearningPreferences).mount(learningPrefsEl)
