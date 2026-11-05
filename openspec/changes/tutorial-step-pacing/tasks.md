## 1. Parser

- [ ] 1.1 Extract and validate trailing heading attributes in `scripts/parsers/v2.ts` before title/slug computation
- [ ] 1.2 Add `timeSeconds` and `optional` to `TutorialStep` (`scripts/parsers/types.ts`) and step frontmatter rendering
- [ ] 1.3 Derive tutorial total time when frontmatter `time` is absent; lint for >25% mismatch and all-optional tutorials
- [ ] 1.4 Unit tests for slug stability, duration grammar, unknown-brace handling

## 2. Backend completion

- [ ] 2.1 Publish `optionalSteps` with tutorial metadata (content publish + `TutorialMeta`)
- [ ] 2.2 Update tutorial-completion check in the progress service to ignore optional steps; tests incl. rollup
- [ ] 2.3 Deploy-order note: backend before content using `optional`

## 3. Rendering and client

- [ ] 3.1 Time chip and Optional badge in step header (`tutorial-step.html` / tutorial layout)
- [ ] 3.2 Remaining-time indicator and Skip control in `hugo/assets/js/tutorial.ts`
- [ ] 3.3 `hugo/assets/js/task-lists.ts`: enable task-list checkboxes, stable IDs with text hash, localStorage persistence, counter, aria-live
- [ ] 3.4 Done-button emphasis when all items checked; CSS (light/dark)

## 4. MCP, docs, tests

- [ ] 4.1 Include `timeMinutes`/`optional` in MCP step tools
- [ ] 4.2 Author docs: step heading attributes + checklists in `docs/authors/writing-tutorials.md`
- [ ] 4.3 e2e spec: optional skip completes tutorial, checklist persistence; corpus regression for unchanged titles/slugs
