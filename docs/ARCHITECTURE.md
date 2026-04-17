# Architecture

This document describes the internal design of `ms-365-admin-mcp-server`.

## High-level flow

```
          +-----------------+
          |   MCP client    |  (Claude Desktop, Claude Code, custom agent)
          +--------+--------+
                   |
   stdio or HTTP   |  MCP protocol (JSON-RPC over streams)
                   v
          +--------+--------+
          |   This server   |
          |                 |
          |  CLI parse      |
          |  Secrets load   |
          |  Auth (MSAL)    |
          |  Tool register  |
          +--------+--------+
                   |
     HTTPS Graph   |
                   v
          +--------+--------+
          |  Microsoft      |
          |  Graph API      |
          +-----------------+
```

## Components

### Entry point — `src/index.ts`

1. Parses CLI args (`parseArgs`).
2. Handles meta-commands first (`--list-tools`, `--list-permissions`, `--list-presets`) and exits.
3. Loads secrets from env or Key Vault (`getSecrets`).
4. Creates the `AuthManager` (MSAL confidential client).
5. If `--verify-login`, tests credentials and exits.
6. Otherwise creates `AdminGraphServer`, initializes, and starts.

### CLI — `src/cli.ts`

Thin wrapper over [commander](https://github.com/tj/commander.js). Adds:

- Preset expansion (`--preset identity,security` becomes a regex via `getCombinedPresetPattern`)
- Read-only default (only `--allow-writes` enables mutations)
- Regex length cap (500 chars, ReDoS prevention)
- `MS365_ADMIN_MCP_CLOUD_TYPE` propagation via env

### Secrets — `src/secrets.ts`

Two providers:

- `EnvironmentSecretsProvider` — reads `MS365_ADMIN_MCP_*` env vars. Default.
- `KeyVaultSecretsProvider` — fetches from Azure Key Vault if `MS365_ADMIN_MCP_KEYVAULT_URL` is set. Uses `DefaultAzureCredential` (local CLI login, managed identity, workload identity, etc.).

Secrets are cached in-process after first retrieval. `clearSecretsCache()` exists for tests.

### Auth — `src/auth.ts`

Wraps `@azure/msal-node`'s `ConfidentialClientApplication`. Responsibilities:

- Validate inputs early (`clientId`, `clientSecret`, specific tenant — rejects `common`).
- Acquire tokens via `acquireTokenByClientCredential` with scope `https://graph.microsoft.com/.default`.
- Cache the token until 60 seconds before expiry.
- `testLogin()` hits `/v1.0/organization` to validate end-to-end.

Also exports `buildPermissionsFromEndpoints(enabledToolsPattern, readOnly)` — collects the unique set of `appPermissions` from `endpoints.json` based on filters, used by `--list-permissions`.

### Graph client — `src/graph-client.ts`

Thin `fetch` wrapper that:

- Adds the bearer token from `AuthManager`
- Applies the cloud-specific base URL (`getCloudEndpoints`)
- Normalizes errors into MCP-friendly `CallToolResult` shapes

### Tool registration — `src/graph-tools.ts`

The core of the server. For each endpoint definition:

1. Build a Zod schema from the generated client's parameter metadata (path, query, header, body, plus OData-friendly descriptions for `$filter`, `$select`, `$top`).
2. Compose a tool description, optionally augmented with `llmTip` and a `RISK LEVEL` warning for non-GET operations (`graph-tools.ts:290-303`).
3. Register via `server.tool(alias, description, paramSchema, hints, handler)`.
4. The handler (`executeGraphTool`) stitches params into the path, query string, and body, then calls `graphClient.graphRequest`.

Skipping logic:

- `readOnly` mode skips any non-GET.
- `enabledToolsRegex` (from `--preset` / `--enabled-tools` / `ENABLED_TOOLS`) filters by tool name.

Security hardening inside the handler (grep for `SEC-` comments):

- `SEC-A` — path-param skip-encoding validated against traversal
- `SEC-D` — query-string encoding via `encodeURIComponent`
- `excludeResponse: true` opt-in to drop the body for operations where the LLM only needs success/failure

### Presets — `src/tool-categories.ts`

A static record mapping preset names to `{ pattern: RegExp, description }`. `getCombinedPresetPattern(names)` unions their regex. Matching happens at tool-registration time against the `toolName` string.

### Stdio server — `src/server.ts`

`AdminGraphServer` wires up:

- `McpServer` from the MCP SDK
- `GraphClient` instance
- Tool registration via `registerGraphTools`
- Transport selection based on `--transport`

For stdio it connects `StdioServerTransport`. For HTTP it delegates to `src/http-server.ts`.

### HTTP server — `src/http-server.ts`

Express app with:

- Security headers
- 100 KB body limit
- 100 req/min rate limit on `/mcp`
- JWT validation middleware on `/mcp` (see `token-validator.ts`)
- `GET /health` unauthenticated
- Stateless MCP transport (`StreamableHTTPServerTransport`) — one fresh transport per request

### Token validation — `src/token-validator.ts`

Per-tenant `jwks-rsa` client with caching (10 min). Verifies:

- RS256 signature
- `iss` = tenant v2 endpoint
- `tid` matches configured tenant
- `appid` / `azp` in `allowedClientIds`
- `aud` matches expected (if provided)
- 30 s clock tolerance

Failures are logged at `warn` with a short reason (no token echoing).

### Cloud config — `src/cloud-config.ts`

Maps `CloudType` (`global` / `china`) to `{ authority, graphApi }` endpoints. Validates the input and defaults to `global`.

### Logger — `src/logger.ts`

Winston logger. Default level depends on `-v` flag. Redacts sensitive fields.

## Data sources

### `src/endpoints.json`

Single source of truth for tool definitions. Each entry:

```jsonc
{
  "toolName": "list-users",
  "pathPattern": "/users",
  "method": "GET",
  "appPermissions": ["User.Read.All"],
  "llmTip": "Use $filter='userType eq ''Guest''' to list guests",
  "riskLevel": "medium",         // only for non-GET
  "skipEncoding": ["userId"],    // optional: path params that should not be URL-encoded
  "contentType": "application/json",
  "acceptType": "application/json",
  "returnDownloadUrl": false
}
```

`endpoints.json` is **hand-curated** (~515 entries). It is the thing a contributor edits.

### `src/generated/`

Auto-generated by `bin/generate-graph-client.mjs` from the Microsoft Graph OpenAPI spec. Contains the typed zod client. **Never hand-edit.**

## Code generation pipeline

`npm run generate` runs `bin/generate-graph-client.mjs`:

1. **Download** the latest Graph OpenAPI spec (`openapi/openapi.yaml`).
2. **Trim** it to only the paths listed in `src/endpoints.json` (`openapi-trimmed.yaml`).
3. **Generate** a zod-typed client via `openapi-zod-client` into `src/generated/`.

This means tool parameter validation is derived automatically from Graph's own schema — you get accurate types for body schemas, path params, query params, enums, etc., without writing them by hand.

The runtime tool registration in `graph-tools.ts` then combines:

- Generated schema (from OpenAPI)  →  parameter validation
- `endpoints.json` metadata         →  risk level, llmTip, skipEncoding, content type
- `tool-categories.ts` regexes      →  preset filtering

## Risk classification

Every non-GET tool carries a `riskLevel`. See [RISK_MODEL.md](RISK_MODEL.md) for the rubric. Risk levels are surfaced to the LLM through the tool description (`graph-tools.ts:295-302`) and serve as machine-readable guardrails for policy enforcement (e.g., an operator wrapper can require explicit human confirmation for `critical`).

## Write protection

Two layers:

1. **Registration-time.** If the server is started without `--allow-writes`, non-GET tools are skipped entirely during registration (`graph-tools.ts:232-235`). They are not exposed to the MCP client.
2. **Permission-time.** `--list-permissions` only emits write scopes when `--allow-writes` is set, so the operator granting admin consent naturally follows least privilege.

## Extensibility points

- **New tools** — add entries to `endpoints.json`, regenerate, done (see [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-new-tool)).
- **New presets** — add regex to `tool-categories.ts`.
- **New secret backend** — implement `SecretsProvider` in `secrets.ts`.
- **New transport** — follow the `http-server.ts` pattern and wire it in `server.ts`.
- **New cloud** — add endpoints to `cloud-config.ts` and extend `parseCloudType`.

## Testing

- **Vitest** (`test/`). Unit tests focus on auth validation, tool parameter parsing, preset regex combinations, token validation, risk-level serialization.
- **MCP Inspector** for interactive E2E testing (`npm run inspector`).
- **`--verify-login`** as a smoke test against a real tenant.

## What's intentionally absent

- **No caching of Graph responses.** Freshness matters for admin data.
- **No automatic retry on 429.** Callers / proxies should handle throttling.
- **No tool result summarization.** The raw Graph response is returned; the LLM decides what to do with it.
- **No audit log of tool invocations by this server.** Graph itself logs every mutation (directory audits, Intune audit, Cloud PC audit); use those for traceability.
- **No per-user authorization.** With application permissions, all calls run as the app. User-scoped authorization belongs in a delegated-permissions server (see [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server)).

## Dependencies

Runtime:

- `@azure/msal-node` — MSAL for client credentials
- `@modelcontextprotocol/sdk` — MCP protocol
- `commander` — CLI parsing
- `dotenv` — local `.env` loading
- `express`, `express-rate-limit` — HTTP transport
- `js-yaml` — OpenAPI parsing
- `jsonwebtoken`, `jwks-rsa` — JWT validation (HTTP mode)
- `winston` — logging
- `zod` — schema validation (via generated client)

Optional:

- `@azure/identity`, `@azure/keyvault-secrets` — Key Vault secret provider

Dev:

- `tsup` — build
- `vitest` — tests
- `eslint`, `prettier` — linting and formatting
- `tsx` — dev runner
