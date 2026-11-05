## 1. Author notes

- [ ] 1.1 Corpus scan of `.tutorial-cache/` for existing `%%` and `:::qa-only` occurrences; triage report
- [ ] 1.2 `scripts/parsers/author-notes.ts` `stripAuthorNotes(body, channel)` (inline/block, fence-aware, attribution, unterminated detection)
- [ ] 1.3 Call it first in `compose.ts`; ensure PROD-published `sourceContent` is the stripped body
- [ ] 1.4 QA rendering: note markers, styles, page counter and toggle in the QA layout
- [ ] 1.5 Drop notes in `renderDirectivesAsText` for QA consumers

## 2. QA-only blocks

- [ ] 2.1 Register `qa-only` container with channel-aware render/removal before step parsing; reject step headings
- [ ] 2.2 QA frame shortcode `tut-qa-only.html` and CSS

## 3. Promotion safeguards

- [ ] 3.1 Lint rule `author-notes-in-prod-source` / `qa-only-in-prod-source`
- [ ] 3.2 Update the `tutorial-qa-to-prod` skill to report and block on leftovers

## 4. CLI deprecation lint

- [ ] 4.1 Create `scripts/lint-rules/data/cli-deprecations.json` with initial curated rules (review with CLI owners)
- [ ] 4.2 `scripts/lint-rules/deprecated-cli.ts` (shell fence detection, prompt stripping, continuation joining)
- [ ] 4.3 Freshness detector imports the rules file and emits findings
- [ ] 4.4 Quarterly review reminder documented in rules file header

## 5. Docs and tests

- [ ] 5.1 Author docs: notes, QA-only blocks, CLI lint
- [ ] 5.2 Unit tests for stripping (both channels, code fences, unterminated), qa-only removal, lint rule matching; e2e for QA notes toggle
