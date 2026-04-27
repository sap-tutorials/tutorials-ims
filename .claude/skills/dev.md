---
name: dev
description: Start the VitePress dev server. Installs dependencies and fetches tutorials if needed before launching.
---

Start the dev server for this project. Run the following steps:

1. Check if `node_modules` exists. If not, run `npm install`.
2. Check if `site/tutorials/_nav.json` exists. If not, run `npm run fetch-tutorials`.
3. Run `npm run dev` in the background.
4. Wait for the dev server to be ready, then report the URL (http://localhost:5173).
