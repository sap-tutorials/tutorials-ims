import { createApp } from 'vue'
import AccountMerge from './AccountMerge.vue'

// IMPORTANT: do NOT import "@ui5/webcomponents/*" here. Every UI5 component this
// island uses (Title, Text, Button, MessageStrip, Input) is registered centrally in
// hugo/assets/js/ui5-bootstrap.ts. See the note in src/me/main.ts.

if (document.getElementById('account-merge'))
  createApp(AccountMerge).mount('#account-merge')
