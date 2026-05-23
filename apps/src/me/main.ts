import { createApp } from 'vue'
import MyCompletions from './MyCompletions.vue'

// U17: Recent Activity timeline on the profile page.
import "@ui5/webcomponents-fiori/dist/Timeline.js";
import "@ui5/webcomponents-fiori/dist/TimelineItem.js";

const el = document.getElementById('me-completions')
if (el) createApp(MyCompletions).mount(el)
