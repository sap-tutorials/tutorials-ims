#!/usr/bin/env bash
# deploy-admin.sh — Deploy approuter with admin UI as static files
#
# Builds the admin shell, copies it into the approuter's static/ directory,
# and deploys the approuter module via MTA.
#
# Usage: bash .deploy/deploy-admin.sh
#
# Prerequisites:
#   - cf login to target space
#   - node, npm, mbt, cf CLI with multiapps plugin
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

echo "=== Step 1: CDS production build ==="
npm install
npx cds build --production

echo "=== Step 2: MTA build ==="
mbt build -s "$SCRIPT_DIR" -p cf --mtar tutorials-admin.mtar

echo "=== Step 3: Deploy approuter (includes admin UI) ==="
cf deploy "$SCRIPT_DIR/mta_archives/tutorials-admin.mtar" \
  -m tutorials-approuter

echo "=== Done! ==="
echo "Visit: https://<approuter-url>/admin-ui/"
