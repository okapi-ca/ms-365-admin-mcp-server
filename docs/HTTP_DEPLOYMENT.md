# HTTP Transport and Remote Deployment

The server supports two transports:

- **stdio** (default) — the MCP client spawns the server as a subprocess over stdin/stdout. Best for Claude Desktop, Claude Code, and local agents.
- **HTTP (StreamableHTTP)** — the server listens on a TCP port and accepts requests from remote MCP clients authenticated with an Entra bearer token. Best for shared deployments (multi-user, Azure-hosted, behind a reverse proxy).

This guide focuses on HTTP mode.

## When to use HTTP mode

Use HTTP when:

- Multiple users or agents share one server instance
- You want to host the server in Azure (Container Apps, AKS, VMs) rather than on each user's laptop
- You need centralized logging, rate limiting, or network-level access control
- Your MCP client lives on a different machine from the server (a common case for agent automation)

Do **not** use HTTP when stdio is sufficient — it's simpler and has a smaller attack surface.

## Quick start

Two auth modes are available, and can be combined:

- **Service-to-service** (machine callers): pre-acquired Entra bearer tokens are validated via `--allowed-clients`.
- **OAuth proxy** (human users on Claude Desktop/Code/Web): the server exposes `/authorize`, `/token`, DCR, and metadata endpoints, delegating auth to Entra and gating by user object ID via `--authorized-users` (or explicitly `--allow-any-tenant-user` to accept every tenant user).

```bash
# Machine-to-machine only
node dist/index.js \
  --transport http \
  --port 8080 \
  --host 127.0.0.1 \
  --allowed-clients "caller-app-id-1,caller-app-id-2"

# Human OAuth only (Claude Desktop/Code/Web)
node dist/index.js \
  --transport http \
  --port 8080 \
  --host 127.0.0.1 \
  --oauth-mode \
  --public-url "https://mcp.example.com" \
  --authorized-users "<user-oid-1>,<user-oid-2>"

# Both at once
node dist/index.js \
  --transport http --port 8080 --host 127.0.0.1 \
  --allowed-clients "<caller-app-id>" \
  --oauth-mode --authorized-users "<user-oid>" --public-url "https://mcp.example.com"
```

At least one of `--allowed-clients` or `--oauth-mode` is **mandatory** in HTTP mode. There is no anonymous access.

Endpoints:

- `GET /health` — unauthenticated liveness probe. Returns `{ status: "ok", transport: "http", timestamp: "..." }`.
- `POST /mcp`, `DELETE /mcp`, `GET /mcp` — MCP protocol endpoints. Require `Authorization: Bearer <token>`.

When `--oauth-mode` is enabled, the following are added:

- `GET /.well-known/oauth-authorization-server` — AS metadata advertising this server as an OAuth 2.0 authorization server (proxying Entra).
- `GET /.well-known/oauth-protected-resource` — RS metadata for MCP spec compliance.
- `POST /register` — Dynamic Client Registration (stub; returns a synthesized `client_id` — all OAuth traffic actually flows through the server's single Entra app).
- `GET /authorize` — 302-redirects to Entra `/oauth2/v2.0/authorize` using a server-side PKCE verifier that bridges to the client's code_challenge.
- `POST /token` — exchanges authorization codes / refresh tokens against Entra, substituting the server's PKCE verifier.

## Authentication model

### OAuth proxy mode (`--oauth-mode`)

The server is an OAuth 2.0 proxy to Entra ID, not a full authorization server. User tokens issued by Entra land on `/mcp` and are validated on each call:

| Check                  | Value                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm              | `RS256` (only)                                                                                                                        |
| Issuer (`iss`)         | `https://login.microsoftonline.com/<tenant>/v2.0` or `https://sts.windows.net/<tenant>/`                                              |
| Tenant (`tid`)         | Must match `MS365_ADMIN_MCP_TENANT_ID`                                                                                                |
| Audience (`aud`)       | One of: `<server-app-id>`, `api://<server-app-id>`, `00000003-0000-0000-c000-000000000000` (Graph)                                    |
| User object ID (`oid`) | Must be present. Must be in `--authorized-users` when that flag is set, otherwise `--allow-any-tenant-user` is required (SEC-F01).    |
| Scopes (`scp`)         | Must contain every scope listed in `--required-user-scopes` (default: `access_as_user`; pass `--required-user-scopes ""` to disable). |
| Signature              | Verified via `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`                                                         |
| Clock tolerance        | 30 seconds                                                                                                                            |

**Important**: the user's token is used only as an **authN gate**. The server does not call Graph on behalf of the user — it calls Graph with its own client-credentials (application permissions), so tool results are identical regardless of which user authenticated. Because of this, the user allowlist and required-scope checks are the **only** layers between an authenticated tenant user and the server's full Graph capability — keep them tight.

#### Entra ID setup for OAuth mode

The server's single Entra app registration must have:

- **Web platform** redirect URIs for every client that will authenticate (e.g., `https://claude.ai/api/mcp/auth_callback`, `http://localhost:3000/oauth/callback`, `https://<your-fqdn>/oauth/callback`).
- **Delegated permissions**: `openid`, `profile`, `email`, `offline_access`, `User.Read` on Microsoft Graph. Admin-consent them once.
- **Allow public client flows** = Yes (so Claude's PKCE-without-secret clients can exchange codes).

Callers (Claude Desktop/Code/Web) discover the server via `/.well-known/oauth-authorization-server` — no client-side config beyond the server URL.

### Service-to-service mode (`--allowed-clients`)

The server validates the incoming JWT against Microsoft JWKS:

| Check                  | Value                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| Algorithm              | `RS256` (only)                                                                |
| Issuer (`iss`)         | `https://login.microsoftonline.com/<tenant>/v2.0`                             |
| Tenant (`tid`)         | Must match `MS365_ADMIN_MCP_TENANT_ID`                                        |
| Client (`appid`/`azp`) | Must be in `--allowed-clients`                                                |
| Audience (`aud`)       | Matches `--expected-audience` (if configured)                                 |
| Signature              | Verified via `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` |
| Clock tolerance        | 30 seconds                                                                    |

Failure modes:

- Missing/malformed `Authorization` header → `401`
- Signature invalid, issuer/tenant/client mismatch → `403`
- Token expired → `403`

## Caller token acquisition

A caller obtains its token via any standard Entra flow. Typical client-credentials example:

```bash
CALLER_CLIENT_ID=... # must be listed in --allowed-clients
CALLER_CLIENT_SECRET=...
TENANT_ID=...
SERVER_AUDIENCE="api://ms-365-admin-mcp-server"  # or the server's Application ID URI

TOKEN=$(curl -s -X POST \
  "https://login.microsoftonline.com/$TENANT_ID/oauth2/v2.0/token" \
  -d "client_id=$CALLER_CLIENT_ID" \
  -d "client_secret=$CALLER_CLIENT_SECRET" \
  -d "grant_type=client_credentials" \
  -d "scope=$SERVER_AUDIENCE/.default" | jq -r .access_token)

curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## Hardening defenses (already implemented)

The server ships with these defenses enabled by default (see `src/http-server.ts`):

| Defense                 | Detail                                                                                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate limit              | `/mcp`: 100 req/min per source IP. `/authorize`: 30 req/min. `/token` and `/register`: 10 req/min. Limits are process-local — multi-replica deployments scale the effective budget per replica. |
| Body size limit         | 100 KB                                                                                                                                                                                          |
| Security headers        | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, CSP `default-src 'none'`, `Referrer-Policy: no-referrer`                                                 |
| Default bind            | `127.0.0.1` (loopback)                                                                                                                                                                          |
| Stateless sessions      | Each request creates a fresh transport; no server-side session state                                                                                                                            |
| Stack trace suppression | Errors return `500` with generic message; details in logs only                                                                                                                                  |

## Operator-provided hardening (you must do this)

The server does not terminate TLS or add caller allowlisting beyond JWT. You must:

1. **Terminate TLS** at a reverse proxy (Azure Front Door, Application Gateway, nginx, Caddy, Cloudflare Tunnel, etc.).
2. **Restrict network exposure** — bind the server to loopback or a private network, front it with the proxy.
3. **Forward `X-Forwarded-For`** so rate limits attribute correctly.
4. **Monitor logs** — all auth failures are logged at `warn`/`error` levels.
5. **Keep OAuth mode on a single replica (SEC-F05)** — the PKCE bridge between `/authorize` and `/token` lives in process memory. The shipped Bicep template defaults `maxReplicas = 1`; if you scale up, externalise the bridge first (Redis / Azure Table) or the OAuth flow will fail intermittently.

### JWKS resilience (SEC-F08)

The server caches Entra signing keys for 24 hours and keeps a per-tenant stale-key map. If Microsoft's JWKS endpoint is temporarily unreachable, previously-validated `kid`s continue to verify tokens (with a `warn`-level log entry) instead of the server returning `403` on every request. Unknown `kid`s still fail closed.

## Docker

```bash
docker build -t ms365-admin-mcp .
docker run --rm -p 8080:8080 \
  -e MS365_ADMIN_MCP_CLIENT_ID=... \
  -e MS365_ADMIN_MCP_CLIENT_SECRET=... \
  -e MS365_ADMIN_MCP_TENANT_ID=... \
  ms365-admin-mcp \
  --transport http \
  --port 8080 \
  --host 0.0.0.0 \
  --allowed-clients "caller-app-id"
```

The Docker image runs as a non-root user. Do not mount writable volumes unless needed.

## Azure Container Apps

A reference Bicep template lives at [infra/main.bicep](../infra/main.bicep). It deploys:

- User-Assigned Managed Identity (UAMI)
- Key Vault (RBAC authorization, purge protection, 90-day soft-delete)
- Log Analytics workspace (retention 30 days)
- Application Insights (linked to the workspace)
- Container App Environment
- Container App using the UAMI, with `MS365_ADMIN_MCP_KEYVAULT_URL` wired to the vault

The UAMI is granted `Key Vault Secrets User`; secrets are seeded after deploy (not via Bicep).

### Deploy

```bash
# Build and push the image to your ACR
az acr build --registry <your-acr> --image ms365-admin-mcp:latest .

# Object IDs that should be able to rotate KV secrets (e.g., you + the ops group)
MY_OID=$(az ad signed-in-user show --query id -o tsv)

# Deploy
az deployment group create \
  --resource-group rg-mcp-admin \
  --template-file infra/main.bicep \
  --parameters \
    baseName=ms365mcpprod \
    containerImage=<your-acr>.azurecr.io/ms365-admin-mcp:latest \
    kvAdminObjectIds="['$MY_OID']"
```

### Seed Key Vault secrets

```bash
KV=$(az deployment group show -g rg-mcp-admin -n main --query properties.outputs.keyVaultName.value -o tsv)
az keyvault secret set --vault-name $KV --name ms365-admin-mcp-client-id     --value <app-client-id>
az keyvault secret set --vault-name $KV --name ms365-admin-mcp-tenant-id     --value <tenant-id>
az keyvault secret set --vault-name $KV --name ms365-admin-mcp-client-secret --value <client-secret>

# Force the Container App to pick up the new secrets on next revision
APP=$(az deployment group show -g rg-mcp-admin -n main --query properties.outputs.containerAppUrl.value -o tsv | awk -F/ '{print $3}' | cut -d. -f1)
az containerapp update -n $APP -g rg-mcp-admin --revision-suffix "seed$(date +%s)"
```

Role-assignment propagation to the UAMI takes ~5 minutes. If the app logs
`Fetching secrets from Key Vault` followed by a 403, wait and redeploy the revision.

### Post-deploy recommendations

1. **Front with Application Gateway or Front Door** for WAF and TLS termination.
2. **Restrict ingress** with `ipSecurityRestrictions` on the Container App, or mark the ingress as `internal: true` behind a private endpoint if callers are in-VNet.
3. **Log forwarding.** Container App stdout is ingested into Log Analytics. Configure a diagnostic setting to stream to your SIEM.
4. **Autoscale.** The server is stateless; scale horizontally on request volume or CPU.

## Operating runbook

### Tail logs

```bash
az containerapp logs show -n <app> -g <rg> --follow
```

### Force a restart / new revision

```bash
az containerapp update -n <app> -g <rg> --revision-suffix "manual$(date +%s)"
```

### Update the image

```bash
az containerapp update -n <app> -g <rg> \
  --image <your-acr>.azurecr.io/ms365-admin-mcp:<new-tag>
```

### Rotate the client secret

```bash
# 1. Create a new secret in Entra ID → App registrations → Certificates & secrets
# 2. Push it to Key Vault (the app reads at startup, so a new revision is needed)
az keyvault secret set --vault-name <kv> --name ms365-admin-mcp-client-secret --value <new-secret>
az containerapp update -n <app> -g <rg> --revision-suffix "rotate$(date +%s)"
# 3. Delete the old secret in Entra ID once the new revision is healthy
```

### Scale tweak

```bash
# Keep one warm instance (no cold start)
az containerapp update -n <app> -g <rg> --min-replicas 1 --max-replicas 5
```

## Estimated cost (Canada East, 2026)

| Resource         | Config                      | Monthly (idle)                      |
| ---------------- | --------------------------- | ----------------------------------- |
| Container App    | Consumption, scale 0–3      | ~0 $ scale-to-zero · ~15–25 $ min=1 |
| Log Analytics    | 30-day retention            | ~2–5 $ depending on log volume      |
| Key Vault        | Standard, low op volume     | <1 $                                |
| Managed Identity | UAMI                        | free                                |
| **Total**        | **scale-to-zero (default)** | **~3–6 $ / month**                  |
| **Total**        | **min=1 replica**           | **~20–30 $ / month**                |

Scale-to-zero produces a cold start of ~2–5 s on the first request after inactivity.
Set `minReplicas=1` in the Bicep parameters if you cannot tolerate this latency.

## Observability

The server logs via Winston in JSON format. Key events:

| Event                           | Level                        | Sample                                                            |
| ------------------------------- | ---------------------------- | ----------------------------------------------------------------- |
| Tool invocation                 | info                         | `Tool list-users called with params: [top, filter]`               |
| Token acquisition (server-side) | info                         | `Acquiring token via client credentials flow...`                  |
| Token validation failure        | warn                         | `Token client ID not in allowed list`                             |
| Graph API error                 | error                        | `testLogin Graph error 403: Forbidden`                            |
| Tool registration summary       | info                         | `Tool registration complete: 515 registered, 0 skipped, 0 failed` |
| Rate limit hit                  | (express-rate-limit default) |                                                                   |

Enable verbose Graph request logging with `-v`.

## Scaling and limits

- **Concurrency.** Node event loop handles concurrent Graph requests. MSAL caches the token for ~1 hour.
- **Rate limits.** Graph API applies tenant-wide throttling (HTTP 429). The server does not currently retry — implement retry at the caller or behind a proxy with queueing.
- **Memory.** Single instance is typically <200 MB. Increase only if you see OOM during large list operations.
- **Paging.** Set `MS365_ADMIN_MCP_MAX_TOP=50` to cap page size and avoid long-running requests on large tenants.

## Health checks

- **Liveness.** `GET /health` returns 200 as long as the process is up.
- **Readiness.** Combine `/health` with a background `--verify-login` in a sidecar if you want to fail readiness when Graph credentials are invalid.

## Migration from stdio to HTTP

1. Deploy the server with `--transport http` somewhere reachable by your MCP client.
2. Create a caller app registration (separate from the server's app registration) and add its client ID to `--allowed-clients`.
3. Update your MCP client configuration to use the HTTP transport (consult your client's docs — Claude Desktop supports HTTP transports as of v0.11).
4. Verify auth with a sample token, then cut over.
