# `@PersonalData` Cascade

The user-anonymization pipeline (`AdminService.anonymizeUser`,
`AdminService.anonymizeByDsrRequest`) runs through a cascade walker that
processes every entity annotated with `@PersonalData` automatically.
Adding a new annotated entity makes it part of the cascade with no JS
changes, provided the entity uses the default `'null-personal'` action.

## Cascade actions

Each `@PersonalData` entity declares its action via `@PersonalData.cascade`.
Four valid values; default is `'null-personal'` when the annotation is absent.

| Value | Semantics | Example |
|---|---|---|
| `'null-personal'` (default) | Set FK = null. Set every `IsPotentiallyPersonal` field = null. Keep row. | `CodeCheckSubmissions` |
| `'delete'` | DELETE rows where FK = user.ID. | `UserMetaData` |
| `'audit-only'` | UPDATE `createdBy` + `modifiedBy` = `'ANONYMIZED'`. Keep row, keep FK. | `TaskRecords` |
| `'identity-replace'` | UPDATE specific identity fields with placeholders/null per `srv/lib/anonymization.js` `buildAnonymizationOps`. | `Users` |

## Adding a new `@PersonalData` entity

In `db/audit-logging.cds`:

```cds
annotate ims.YourNewEntity with @PersonalData: {
  EntitySemantics: 'Other'  // or 'DataSubjectDetails' if the row describes a subject
  // No cascade override → default 'null-personal' applies.
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';            // required: which field is the user FK?
  someField @PersonalData.IsPotentiallyPersonal;                  // optional: any field worth nulling
};
```

That's it. No code change to `srv/admin-service.js` or `srv/lib/anonymization-cascade.js`.

If you need a non-default action, add `cascade: '<action>'` to the entity-level
annotation. See `db/audit-logging.cds` for the existing examples.

## When the walker skips an entity

If an entity has `@PersonalData` but no field annotated with
`FieldSemantics: 'DataSubjectID'` (i.e. there's no FK telling the walker
which rows belong to the user being anonymized), the walker logs a warning
and emits `action: 'skip'` for that entity. The deploy log will show:

```
[anonymization-cascade] WARN  Entity ims.YourEntity has @PersonalData but no FieldSemantics: 'DataSubjectID' field — skipping cascade.
```

Same applies if `cascade:` has an unrecognised value. The cascade does NOT
fail fast — it logs and continues, so a partial misconfiguration cannot
block GDPR compliance.

## Reference

- Module: [`srv/lib/anonymization-cascade.js`](../../../srv/lib/anonymization-cascade.js)
- Annotations: [`db/audit-logging.cds`](../../../db/audit-logging.cds)
- Spec: [`docs/superpowers/specs/2026-06-03-anonymize-cascade-design.md`](../../superpowers/specs/2026-06-03-anonymize-cascade-design.md)
- Tracking: [sap-tutorials/tutorials-ims#211](https://github.com/sap-tutorials/tutorials-ims/issues/211)
