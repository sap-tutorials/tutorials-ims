---
title: GraphQL API
description: Query the SAP Developers tutorials, missions, groups, and knowledge graph over GraphQL.
weight: 40
---

## Quickstart

Hit our GraphQL endpoint with any HTTP client:

```bash
curl -s https://developers.sap.com/graphql/public \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ KnowledgeGraphService { PublishedConcepts { totalCount value { slug name description } } } }"}'
```

Interactive query editor: [GraphiQL](/graphql/public).

## Endpoints

| Path | Auth | Contents |
|---|---|---|
| `/graphql/public` | none | Public read data — published concepts, search |
| `/graphql`        | XSUAA bearer with scope `Tutorial.API` | Everything above + user-scoped reads on `DeveloperService` |

## Getting a Token

We support two OAuth2 flows against the tutorials XSUAA instance:

### Authorization code + PKCE (interactive)

```bash
# 1. Generate PKCE pair
CODE_VERIFIER=$(openssl rand -base64 64 | tr -d '=+/' | cut -c1-64)
CODE_CHALLENGE=$(printf '%s' "$CODE_VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# 2. Send the user to
open "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/authorize?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<REDIRECT>&code_challenge=$CODE_CHALLENGE&code_challenge_method=S256"

# 3. Exchange the returned code for a bearer
curl -s "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -u "$CLIENT_ID:" \
  -d "grant_type=authorization_code&code=$CODE&redirect_uri=$REDIRECT&code_verifier=$CODE_VERIFIER"
```

### Client credentials (backend-to-backend)

```bash
curl -s "https://<subdomain>.authentication.<region>.hana.ondemand.com/oauth/token" \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d 'grant_type=client_credentials'
# → { "access_token": "…", "token_type": "bearer", "expires_in": 43199 }
```

Requires a service key on the tutorials XSUAA instance. Request one through the platform team.

## Prerequisite: Role Collection Assignment

The `Tutorial.API` scope is only granted to identities assigned the **Tutorials API Consumer** role collection in your BTP subaccount. Ask a subaccount administrator to:

1. Open the [BTP cockpit](https://cockpit.btp.cloud.sap) → your subaccount → **Security** → **Role Collections**.
2. Locate the `Tutorials API Consumer` role collection (auto-created by the tutorials MTA deploy).
3. Assign your identity (via **User** or **Identity Provider** tab).

Without this assignment your bearer token will authenticate successfully at `/graphql` but every `DeveloperService.me.*` query returns HTTP 200 with a GraphQL `errors[].extensions.code: "403"`.

## Example Queries

### Public concepts

```graphql
{
  KnowledgeGraphService {
    PublishedConcepts { totalCount value { slug name description } }
  }
}
```

### Full-text search

```graphql
{
  SearchService {
    SearchableItems(search: "cap", top: 5) {
      value { title description type }
      totalCount
    }
  }
}
```

### Authenticated — your progress

```graphql
{
  DeveloperService {
    Tutorials { totalCount value { slug title } }
  }
}
```

### With a token — your task records

```bash
curl -s https://developers.sap.com/graphql \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query": "{ DeveloperService { Tutorials { totalCount value { slug title } } } }"}'
```

## Schema

- **SDL:** [schema.graphql](/graphql/schema.graphql) (published every release)
- **Introspection:** on in every environment

## Versioning

The schema is evolved **additively**. New fields, entities, and optional args land freely. Renames and removals are announced in the release notes and marked `@deprecated` on the outgoing element for at least one release before removal.

## Limitations (v1)

- Read-only. Mutations, subscriptions, and actions/functions are out of scope.
- Draft-enabled entities are not exposed.
- No per-field cost limits or persisted queries yet — do not send abusive queries.
