import { createApp } from 'vue'
import ApiTokens from './ApiTokens.vue'

// IMPORTANT: do NOT import "@ui5/webcomponents/*" here. Every UI5 component this
// island uses (Title, Text, Button, MessageStrip) is registered centrally in
// hugo/assets/js/ui5-bootstrap.ts. See the note in src/me/main.ts.

if (document.getElementById('api-tokens'))
  createApp(ApiTokens).mount('#api-tokens')
