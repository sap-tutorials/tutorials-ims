#!/usr/bin/env bash
# tools/regen-card-parity-fixtures.sh
# One-shot fixture regeneration for card-template-parity.test.ts +
# BrowsePage.hydration.test.ts.
#
# Run when card markup intentionally changes; commit the updated
# fixtures alongside the markup change.
#
# Why this exists: Hugo-from-Vitest is brittle on Windows. We capture
# Hugo's rendered output once, store it as a fixture, and the test
# compares Vue's renderToString output against that captured string.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
FIXTURE_DIR="${REPO_ROOT}/hugo-apps/src/browse/__tests__/fixtures"
FIXTURES_JSON="${FIXTURE_DIR}/cards.fixtures.json"
TEMP_HUGO="${REPO_ROOT}/tools/.parity-fixtures"

if [ ! -f "$FIXTURES_JSON" ]; then
  echo "ERROR: fixture data missing: $FIXTURES_JSON" >&2
  exit 1
fi

# ── 1. Card-partial fixtures ─────────────────────────────────────────
# Build a tiny Hugo site that renders each card partial in isolation.

rm -rf "$TEMP_HUGO"
mkdir -p "$TEMP_HUGO/layouts" "$TEMP_HUGO/content" "$TEMP_HUGO/data"
cp "$FIXTURES_JSON" "$TEMP_HUGO/data/cards.json"

mkdir -p "$TEMP_HUGO/layouts/partials/browse/_partials"
cp "${REPO_ROOT}/hugo/layouts/partials/browse/_partials/card-tutorial.html" \
   "$TEMP_HUGO/layouts/partials/browse/_partials/"
cp "${REPO_ROOT}/hugo/layouts/partials/browse/_partials/card-mission.html" \
   "$TEMP_HUGO/layouts/partials/browse/_partials/"
cp "${REPO_ROOT}/hugo/layouts/partials/browse/_partials/card-group.html" \
   "$TEMP_HUGO/layouts/partials/browse/_partials/"

for kind in tutorial mission group; do
  cat > "$TEMP_HUGO/content/${kind}.md" <<MD
---
title: ${kind}
type: page
layout: ${kind}
---
MD
  cat > "$TEMP_HUGO/layouts/${kind}.html" <<HTML
{{- partial "browse/_partials/card-${kind}.html" (index .Site.Data.cards "${kind}") -}}
HTML
done

cat > "$TEMP_HUGO/hugo.toml" <<TOML
baseURL = "/"
title = "parity-fixtures"
disableKinds = ["RSS", "sitemap", "taxonomy", "term"]
TOML

(cd "$TEMP_HUGO" && hugo --quiet --destination public)

for kind in tutorial mission group; do
  if [ ! -f "$TEMP_HUGO/public/${kind}/index.html" ]; then
    echo "ERROR: Hugo did not render ${kind}/index.html" >&2
    exit 1
  fi
  cp "$TEMP_HUGO/public/${kind}/index.html" "$FIXTURE_DIR/card-${kind}.expected.html"
done

rm -rf "$TEMP_HUGO"

# ── 2. Full /browse/ page-1 fixture ──────────────────────────────────
# Runs Hugo against the real project layouts with a small synthetic
# browse.json — captures the SSR'd page used by BrowsePage.hydration.test.ts.

BROWSE_DATA="${REPO_ROOT}/hugo/data/browse.json"
BROWSE_DATA_BACKUP=""
if [ -f "$BROWSE_DATA" ]; then
  BROWSE_DATA_BACKUP="${BROWSE_DATA}.parity-backup"
  mv "$BROWSE_DATA" "$BROWSE_DATA_BACKUP"
fi

cat > "$BROWSE_DATA" <<'EOF'
{
  "all": [
    {"type":"mission","id":"mission-1","title":"Build with CAP","description":"Full-stack mission","time":240,"level":"intermediate","tutorialCount":8,"primaryTag":"cap","displayTags":["CAP"],"displayTagSlugs":["software-product>sap-cloud-application-programming-model"],"href":"/tutorials/mission-build-with-cap","stepCount":40},
    {"type":"group","id":"group-1","title":"CAP Basics","description":"Three tutorials","time":90,"level":"beginner","tutorialCount":3,"primaryTag":"cap","displayTags":[],"displayTagSlugs":[],"href":"/tutorials/group-cap-basics","stepCount":12},
    {"type":"tutorial","id":"cap-getting-started","title":"CAP Getting Started","description":"Build a CAP service in 30 min","time":30,"level":"beginner","tutorialCount":1,"primaryTag":"cap","displayTags":["CAP"],"displayTagSlugs":["software-product>sap-cloud-application-programming-model"],"href":"/tutorials/cap-getting-started","stepCount":3,"isNew":true,"createdAt":"2026-06-01T00:00:00Z"}
  ],
  "featured": ["mission-1"],
  "recent": ["cap-getting-started"],
  "buildAt": "2026-06-03T17:00:00Z"
}
EOF

# Run Hugo against the full project to produce hugo/public/browse/index.html.
# We need a real run (not a temp site) so the SSR'd page picks up the actual
# layouts/browse/list.html plus all its partials.
(cd "${REPO_ROOT}/hugo" && hugo --quiet --destination public-parity-fixture)

if [ ! -f "${REPO_ROOT}/hugo/public-parity-fixture/browse/index.html" ]; then
  echo "ERROR: Hugo did not render browse/index.html" >&2
  # Restore data file before exiting
  rm -f "$BROWSE_DATA"
  if [ -n "$BROWSE_DATA_BACKUP" ]; then mv "$BROWSE_DATA_BACKUP" "$BROWSE_DATA"; fi
  exit 1
fi

cp "${REPO_ROOT}/hugo/public-parity-fixture/browse/index.html" \
   "$FIXTURE_DIR/browse-page-1.html"

# Cleanup
rm -rf "${REPO_ROOT}/hugo/public-parity-fixture"
rm -f "$BROWSE_DATA"
if [ -n "$BROWSE_DATA_BACKUP" ]; then
  mv "$BROWSE_DATA_BACKUP" "$BROWSE_DATA"
fi

echo "Regenerated fixtures in: $FIXTURE_DIR"
ls -1 "$FIXTURE_DIR"
