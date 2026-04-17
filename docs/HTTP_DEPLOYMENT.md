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

```bash
node dist/index.js \
  --transport http \
  --port 8080 \
  --host 127.0.0.1 \
  --allowed-clients "caller-app-id-1,caller-app-id-2"
```

`--allowed-clients` is **mandatory** in HTTP mode. There is no anonymous access.

Endpoints:

- `GET /health` — unauthenticated liveness probe. Returns `{ status: "ok", transport: "http", timestamp: "..." }`.
- `POST /mcp`, `DELETE /mcp`, `GET /mcp` — MCP protocol endpoints. Require `Authorization: Bearer <token>`.

## Authentication model

The server validates the incoming JWT against Microsoft JWKS:

| Check              | Value                                                      |
| ------------------ | ---------------------------------------------------------- |
| Algorithm          | `RS256` (only)                                             |
| Issuer (`iss`)     | `https://login.microsoftonline.com/<tenant>/v2.0`          |
| Tenant (`tid`)     | Must match `MS365_ADMIN_MCP_TENANT_ID`                     |
| Client (`appid`/`azp`) | Must be in `--allowed-clients`                         |
| Audience (`aud`)   | Matches `--expected-audience` (if configured)              |
| Signature          | Verified via `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` |
| Clock tolerance    | 30 seconds                                                 |

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

| Defense            | Detail                                                             |
| ------------------ | ------------------------------------------------------------------ |
| Rate limit         | 100 req/min per source IP on `/mcp`                                |
| Body size limit    | 100 KB                                                             |
| Security headers   | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Cache-Control: no-store`, CSP `default-src 'none'`, `Referrer-Policy: no-referrer` |
| Default bind       | `127.0.0.1` (loopback)                                             |
| Stateless sessions | Each request creates a fresh transport; no server-side session state |
| Stack trace suppression | Errors return `500` with generic message; details in logs only |

## Operator-provided hardening (you must do this)

The server does not terminate TLS or add caller allowlisting beyond JWT. You must:

1. **Terminate TLS** at a reverse proxy (Azure Front Door, Application Gateway, nginx, Caddy, Cloudflare Tunnel, etc.).
2. **Restrict network exposure** — bind the server to loopback or a private network, front it with the proxy.
3. **Forward `X-Forwarded-For`** so rate limits attribute correctly.
4. **Monitor logs** — all auth failures are logged at `warn`/`error` levels.

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

- Log Analytics workspace (retention 30 days)
- Application Insights (linked to the workspace)
- Container App Environment
- Container App with system-assigned managed identity

### Deploy

```bash
# Build and push the image to your ACR
az acr build --registry <your-acr> --image ms365-admin-mcp:latest .

# Deploy
az deployment group create \
  --resource-group rg-mcp-admin \
  --template-file infra/main.bicep \
  --parameters \
    containerImage=<your-acr>.azurecr.io/ms365-admin-mcp:latest \
    tenantId=$TENANT_ID \
    clientId=$CLIENT_ID \
    clientSecret=$CLIENT_SECRET
```

### Post-deploy recommendations

1. **Front with Application Gateway or Front Door** for WAF and TLS termination.
2. **Switch to managed identity** — remove the client-secret parameter, assign the Container App's managed identity the Graph permissions directly, and use `DefaultAzureCredential` (requires a code change to swap MSAL client-credentials for managed-identity token acquisition, planned).
3. **Use Key Vault for the secret** — set `MS365_ADMIN_MCP_KEYVAULT_URL` and store the client secret as `ms365-admin-mcp-client-secret`. Grant the Container App's managed identity `get` access on the vault secrets.
4. **Log forwarding.** Container App stdout is ingested into Log Analytics. Configure a diagnostic setting to stream to your SIEM.
5. **Autoscale.** The server is stateless; scale horizontally on request volume or CPU.

## Observability

The server logs via Winston in JSON format. Key events:

| Event                           | Level | Sample                                                          |
| ------------------------------- | ----- | --------------------------------------------------------------- |
| Tool invocation                 | info  | `Tool list-users called with params: [top, filter]`              |
| Token acquisition (server-side) | info  | `Acquiring token via client credentials flow...`                |
| Token validation failure        | warn  | `Token client ID not in allowed list`                           |
| Graph API error                 | error | `testLogin Graph error 403: Forbidden`                          |
| Tool registration summary       | info  | `Tool registration complete: 515 registered, 0 skipped, 0 failed` |
| Rate limit hit                  | (express-rate-limit default) |                                                |

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
