# HANA-Native AI Core Embeddings — Setup Runbook

> **What this is.** How to connect the existing SAP AI Core instance to a
> `tutorials-ims` HANA container so embeddings can be generated **by SQL
> inside the database** (`VECTOR_EMBEDDING`), instead of only at the
> Node/CAP layer. Tracks issue
> [#2810](https://github.com/sap-tutorials/tutorials-ims/issues/2810).
> Design rationale: [`docs/superpowers/specs/2026-10-19-hana-aicore-embedding-design.md`](../../superpowers/specs/2026-10-19-hana-aicore-embedding-design.md).
>
> **Status:** DEV setup. This is the *connection + proof* unit only — no
> application feature has been moved to DB-side embeddings yet.

## Two tiers

| Tier | What | AI Core needed? | Privilege needed? |
| --- | --- | --- | --- |
| **A — built-in NLP** | HANA's own embedding models (`SAP_GXY.20250407`, `SAP_NEB.20240715`) | No | None |
| **B — AI Core remote source** | AI Core gen-AI hub models (`text-embedding-3-small`, …) via `sapgenaihub` adapter | Yes | admin creates PSE + remote source (one-time); container gets `EXECUTE` only |

Tier A works out of the box and is the fastest sanity check. Tier B is
issue #2810's actual target.

---

## Tier A — built-in NLP embedding (no setup)

Run as the container runtime user (any `tutorials-hana` service key /
`cds bind`). Confirms `VECTOR_EMBEDDING` works from the DB layer:

```sql
SELECT VECTOR_EMBEDDING('Hello world!', 'DOCUMENT', 'SAP_GXY.20250407') FROM DUMMY;
```

Expected: a 768-dimension `REAL_VECTOR`. List available built-in models
with `SELECT * FROM NLP_VECTOR_EMBEDDING_MODELS;`.

> **Verified on DEV 2026-10-19:** returned a 768-dim vector.

---

## Tier B — AI Core remote source

### Prerequisites

1. **Dedicated x509 service key** on the AI Core instance. On DEV this is
   `hana-ai-core` on `tutorials-aicore` (a separate key from the CAP app
   binding — different security requirements). Create with:
   ```bash
   cf create-service-key tutorials-aicore hana-ai-core \
     -c '{"credential-type":"x509","validity":365,"validity-type":"DAYS"}'
   cf service-key tutorials-aicore hana-ai-core   # read values
   ```
   You need from the key JSON: `serviceurls.AI_API_URL`, `certurl`,
   `clientid`, `certificate`, `key`.

2. **AI Core deployment ID** of an orchestration deployment. List RUNNING
   deployments (x509 mTLS against the token endpoint, then `/v2/lm/deployments`):
   ```
   POST  {certurl}/oauth/token    grant_type=client_credentials&client_id={clientid}   (client cert + key as mTLS)
   GET   {AI_API_URL}/v2/lm/deployments?status=RUNNING   Authorization: Bearer <token>  AI-Resource-Group: default
   ```
   Pick an `orchestration`-scenario deployment ID.

   > **DEV worked example:** deployment `da6d9c5e3fb50c3d`
   > (`joule-chat-orchestration`). Other RUNNING on DEV:
   > `d2f9fa53543e5c4e` (defaultOrchestrationConfig),
   > `dfad0fa7cd47ab38` (text-embedding-3-small).

### Step B1 — one-time admin setup: PSE + remote source

> **This is an instance-level admin action, not a container artifact.** A
> PSE and a remote source are database-level objects created **once** by a
> privileged user (DBADMIN or equivalent holding `TRUST ADMIN`). They are
> shared — one AI Core remote source can serve every container/app on the
> instance. Do **not** try to grant `TRUST ADMIN`/PSE privileges into an
> HDI container; the container only needs `EXECUTE` on the finished remote
> source (Step B2).
>
> **Why not the container:** we initially tried to grant the PSE privilege
> into the `tutorials-hana` container (via `_grants.hdbgrants`, then via
> `default_access_role.hdbrole`). That is the wrong shape — it would give
> every app binding user a powerful PKI system privilege permanently for a
> one-time task, and the container `#OO` can't grant these privileges
> anyway (`#OO` is not allowed to grant `CERTIFICATE ADMIN`). See the
> "Failed approaches" box below.

Run as a **DEV HANA admin**. Paste the **private key then the client
certificate** from the `hana-ai-core` service key, unescaped (`\n` → real
line breaks) — the key's `key` value (RSA private key PEM block) directly
followed by its `certificate` value (certificate PEM block):

```sql
CREATE PSE TUTORIALS_AICORE_PSE;
ALTER PSE TUTORIALS_AICORE_PSE SET OWN CERTIFICATE '
<<< hana-ai-core service-key "key" value here (RSA private key PEM block) >>>
<<< hana-ai-core service-key "certificate" value here (certificate PEM block) >>>
';

CREATE REMOTE SOURCE TUTORIALS_AICORE ADAPTER "sapgenaihub" CONFIGURATION
  'aiApiUrl=<AI_API_URL>;
   authUrl=<certurl>;
   resourceGroup=default;
   deploymentId=<deploymentId>;
   clientId=<clientid>'
WITH CREDENTIAL TYPE 'X509' PSE TUTORIALS_AICORE_PSE;
```

DEV worked values: `aiApiUrl=https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com`,
`authUrl=https://tutorial-system.authentication.cert.eu10.hana.ondemand.com`,
`deploymentId=da6d9c5e3fb50c3d`,
`clientId=sb-78c0840a-3613-4a19-be4f-5cd52760090e!b676072|aicore!b540`.

Privileges the admin needs: `TRUST ADMIN` (for `CREATE PSE`),
`CREATE REMOTE SOURCE`. `CERTIFICATE ADMIN` is only for *managed* PSEs
(JWKS-URL), not needed for `SET OWN CERTIFICATE`.

> **Secrets:** cert + private key come only from the live service key —
> never commit them. Pull at setup via `cf service-key tutorials-aicore
> hana-ai-core`. Rotate `hana-ai-core` if the key JSON was exposed
> anywhere shared.

<details><summary><b>Failed approaches (do not repeat)</b></summary>

1. `CREATE PSE` in `_grants.hdbgrants` under `tutorials-kg-grantor` (DEV
   `20261019-105602`) → `invalid role name: CREATE PSE`. System
   privileges can't be granted via that SQL-grantor path.
2. `"system_privileges": ["CREATE PSE"]` in `default_access_role.hdbrole`
   (DEV `20261019-115443`) → `"CREATE PSE": invalid system privilege`.
   `CREATE PSE` is the statement; the privilege is `TRUST ADMIN`.
3. `"system_privileges": ["TRUST ADMIN","CERTIFICATE ADMIN"]` in the role
   (DEV `20261019-125352`) → `user "…#OO" is not allowed to grant …
   "CERTIFICATE ADMIN"`. The container `#OO` cannot delegate PKI system
   privileges — confirming PSE setup does not belong in the container.

Root cause: PSE/remote-source setup is instance-level admin work, not a
per-container grant. `default_access_role.hdbrole` remains the right
mechanism for privileges the container user *should* own long-term — just
not for this.
</details>

### Step B2 — grant the container `EXECUTE` on the remote source

The **only** container-scoped grant needed. As the admin (or via a
grantor the container can use), grant the `tutorials-hana` runtime user
EXECUTE on the shared remote source:

```sql
GRANT EXECUTE ON REMOTE SOURCE TUTORIALS_AICORE
  TO "AC9753D6C4764F5ABE3B3CA4E88233C0_..._RT";  -- the container _RT user
```

This can also be delivered declaratively via `.hdbgrants` (a remote-source
object privilege a grantor can delegate) if we want it in the container
lifecycle later — but for the DEV proof the direct admin grant is fine.

> **Lifecycle caveat:** a PSE / remote source created imperatively by the
> runtime user is **not** an HDI-managed artifact and will be orphaned on
> the next `tutorials-db-deployer` container rebuild. Acceptable for this
> DEV proof. **Before any feature rewrite, convert these to design-time
> artifacts** (`.hdbpse` + remote-source artifact) so they survive
> redeploy — tracked as a follow-up.

### Step B3 — prove it

```sql
CALL GET_REMOTE_SOURCE_AI_MODELS('TUTORIALS_AICORE', ?);   -- enumerate reachable embedding models
-- use a model+version from that list, e.g. text-embedding-3-small.1
SELECT VECTOR_EMBEDDING('Hello world!', 'DOCUMENT',
  'text-embedding-3-small.1', TUTORIALS_AICORE) FROM DUMMY;
```

Expected: a non-null `REAL_VECTOR` (dimension depends on the model).
Recommended: a thin hybrid test asserting a non-null vector returns.

---

## PROD repeat checklist

Same steps, PROD inputs. Confirm `cf target` is PROD before any key read.

- [ ] Create / confirm a dedicated x509 key on the PROD AI Core instance.
- [ ] Retrieve a PROD orchestration deployment ID.
- [ ] As a PROD HANA admin, run B1 (CREATE PSE + remote source) with PROD
      `AI_API_URL` / `certurl` / `deploymentId` / `clientId`.
- [ ] Grant `EXECUTE ON REMOTE SOURCE` to the PROD container `_RT` user (B2).
- [ ] Run B3 proof.

---

## Appendix 1 — Automatic embedding generation (for the later rewrite)

Once the remote source works, HANA can keep embeddings in sync with
source text with no application pipeline. Four mechanisms:

| Method | Column type | Timing |
| --- | --- | --- |
| `CREATE_VECTOR_EMBEDDINGS` system procedure | NCLOB, NVARCHAR | On-demand / one-time backfill |
| Scheduler job (`CREATE SCHEDULER JOB` → the procedure) | NCLOB, NVARCHAR | Periodic background sync |
| `GENERATED ALWAYS AS VECTOR_EMBEDDING(...)` computed column | **NVARCHAR only** | Synchronous on insert/update |
| `BEFORE INSERT OR UPDATE` trigger | NCLOB, NVARCHAR | Synchronous on insert/update |

> This platform's content is stored as **NCLOB** (gzip BLOB / long text),
> so `GENERATED ALWAYS AS` (NVARCHAR-only) does **not** apply — use the
> procedure (backfill), scheduler job (periodic), or trigger (synchronous)
> routes. Example backfill:
> ```sql
> CALL SYS.CREATE_VECTOR_EMBEDDINGS(
>   SCHEMA_NAME => CURRENT_SCHEMA, TABLE_NAME => 'KNOWLEDGE_BASE',
>   TEXT_COLUMN_NAME => 'TEXT', EMBEDDING_COLUMN_NAME => 'TEXT_EMBEDDING',
>   TEXT_TYPE => 'DOCUMENT', MODEL_AND_VERSION => 'SAP_GXY.20250407');
> ```

## Appendix 2 — Wider HANA AI function surface

From the SAP HANA AI Development Guide — candidates for later moving
Node/CAP AI work into the DB layer (each worth its own evaluation unit):

- `VECTOR_EMBEDDING`, `CREATE_VECTOR_EMBEDDINGS` — embeddings (this doc).
- `AI_TEXT_COMPLETION` — LLM text generation in SQL.
- `AI_CORE_REQUEST` — generic AI Core call from SQL.
- `CROSS_ENCODE` — reranking / cross-encoder scoring.
- `AI_TABULAR_PREDICTION` — tabular ML prediction (cf. RPT ValueList use).

These overlap with features currently served via `@cap-js/ai` /
`@sap-ai-sdk/orchestration` (semantic search, text-gen, Joule, RPT
recommendations); consolidation is a future architecture decision, not
part of this unit.
