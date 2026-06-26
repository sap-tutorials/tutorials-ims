import { createApp } from 'vue'
import RecentActivity from './RecentActivity.vue'
import AllCompletions from './AllCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'
import CommunityProfile from './CommunityProfile.vue'

// IMPORTANT: do NOT import "@ui5/webcomponents/*" or "@ui5/webcomponents-fiori/*"
// from this entry. Every UI5 component these islands use is registered in
// hugo/assets/js/ui5-bootstrap.ts. See [feedback_ui5_duplicate_bundle_kills_settheme].
//
// Components used across /me islands (all registered in ui5-bootstrap.ts):
//   Title, Select, Option, MessageStrip, Button, Label, Text, Timeline,
//   TimelineItem, Panel, Avatar, Input, IllustratedMessage.

if (document.getElementById('me-recent-activity'))
  createApp(RecentActivity).mount('#me-recent-activity')

if (document.getElementById('me-all-completions'))
  createApp(AllCompletions).mount('#me-all-completions')

if (document.getElementById('me-learning-preferences'))
  createApp(LearningPreferences).mount('#me-learning-preferences')

if (document.getElementById('me-community-profile'))
  createApp(CommunityProfile).mount('#me-community-profile')
