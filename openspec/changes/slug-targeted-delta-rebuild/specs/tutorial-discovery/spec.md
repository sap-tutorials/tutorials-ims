## ADDED Requirements

### Requirement: GraphQL errors are surfaced, not masked
The GraphQL client SHALL treat a response containing GraphQL-level errors or a null `data` field as a failure and MUST raise an error that includes the GraphQL error type and message, rather than returning the null data for callers to dereference.

#### Scenario: GraphQL error raises with cause
- **WHEN** the GitHub GraphQL API returns an errors array or null `data`
- **THEN** the client raises an error whose message contains the GraphQL error type/message
- **AND** callers do not throw an opaque "cannot read properties of undefined" TypeError

### Requirement: Discovery uses a token that can resolve its query
Tutorial discovery SHALL run with credentials capable of resolving its GraphQL query (the organization node), or SHALL be restructured to enumerate repositories without an org-level GraphQL node. Discovery MUST NOT silently fall back to a slower path due to a token-scope gap.

#### Scenario: Discovery succeeds on the primary path
- **WHEN** a rebuild runs with the configured token
- **THEN** repository discovery completes on its primary path without falling back per-batch to REST

### Requirement: Fallback is loud
If discovery or metadata fetch degrades to a REST fallback because of an auth/permission GraphQL error, the pipeline SHALL emit a clear error-level log line identifying the degradation and its cause, so a token-scope regression is visible rather than hidden as latency.

#### Scenario: Degradation is logged at error level
- **WHEN** the GraphQL path fails with a permission/auth error and the pipeline falls back to REST
- **THEN** a single error-level log line states that discovery/metadata degraded to REST and includes the underlying cause

#### Scenario: Correctness preserved on fallback
- **WHEN** the REST fallback is used
- **THEN** the discovered tutorial set and per-slug metadata are equivalent to the GraphQL path (no silent divergence)
