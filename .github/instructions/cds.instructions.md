---
applyTo: "db/**/*.cds,srv/**/*.cds,app/*.cds,db-qa/**"
---
# CDS model

- Before you edit, look up entities and annotations with the CAP MCP server: `search_model` for the compiled model, `search_docs` for CAP docs.
- Don't select a HANA BLOB in the same CDS QL query as its metadata. LOB locators expire. Use raw `db.run()`, following the pattern in `srv/lib/content-store.js`.
- Slugs on `TutorialMeta`, `Tutorials`, `Missions` and `Groups` are unique and lowercase. New write paths must upsert on slug.
- Don't bypass `@requires` or `@restrict`. Never edit `gen/`; regenerate it with `cds build`.
- Keep `using` side-effect imports, for example the TechEd one in `db/external-content.cds`.
