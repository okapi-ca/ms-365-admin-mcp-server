# Troubleshooting

Common errors and how to diagnose them.

## Quick diagnostics

```bash
# Verify credentials and tenant connectivity
node dist/index.js --verify-login

# List tools that would load for your configuration
node dist/index.js --preset <your-presets> --list-tools

# List exact permissions your configuration needs
node dist/index.js --preset <your-presets> --list-permissions

# Run with verbose logging
node dist/index.js -v
```

---

## Startup errors

### `MS365_ADMIN_MCP_CLIENT_ID is required`

The env var is unset or empty. Set it in your environment or `.env` file.

```bash
export MS365_ADMIN_MCP_CLIENT_ID=<application-client-id-from-entra>
```

### `MS365_ADMIN_MCP_TENANT_ID must be a specific tenant ID (not "common")`

Client credentials flow is single-tenant only. Replace `common` with your directory (tenant) GUID, visible in **Entra admin center → Overview**.

### `Required secret ms365-admin-mcp-client-id not found in Key Vault`

Key Vault mode expects these secret names exactly:

- `ms365-admin-mcp-client-id`
- `ms365-admin-mcp-tenant-id`
- `ms365-admin-mcp-client-secret`
- `ms365-admin-mcp-cloud-type` (optional)

Also confirm the identity running the server has the `get` secret permission on the vault.

### `Error: invalid --enabled-tools regex`

Your regex did not compile. Test it in isolation:

```bash
node -e "new RegExp('your-pattern', 'i')"
```

The server also rejects patterns longer than 500 chars (ReDoS prevention).

---

## Authentication

### `AADSTS700016: Application with identifier X was not found`

The client ID is wrong or the app was deleted. Copy it fresh from **Entra → App registrations → Overview → Application (client) ID**.

### `AADSTS7000215: Invalid client secret provided`

- The secret expired. Check **Certificates & secrets → Client secrets → Expires** column.
- You copied the `Secret ID` instead of the `Value`. Only the `Value` (shown once at creation time) works.
- There are leading/trailing whitespace characters. Re-export without quotes.

### `AADSTS65001: The user or administrator has not consented to use the application`

Admin consent was never granted. In the Entra admin center → **API permissions** → **Grant admin consent for <tenant>**. You need Global Administrator or Privileged Role Administrator.

### `AADSTS50059: No tenant-identifying information found in request`

You probably passed `common` as the tenant. Use a specific tenant GUID.

### `AADSTS90002: Tenant X not found`

Typo in the tenant ID, or the tenant is in a different cloud (China, Government). For 21Vianet, add `--cloud china`.

### `--verify-login` returns `success: false` with `Forbidden`

- Admin consent granted but Graph has not propagated (wait 5-10 minutes).
- The app has no `Organization.Read.All` or equivalent. `--verify-login` reads the org entity.

---

## Permissions at runtime

### `Insufficient privileges to complete the operation`

- The specific tool requires a permission you did not grant. Run:

  ```bash
  node dist/index.js --list-tools | grep <tool-name>
  # then check its permissions list
  ```

- Add the missing permission in **Entra → API permissions** and grant admin consent.

### `Request_ResourceNotFound` on `list-sign-ins`, `list-directory-audits`

Azure AD audit logs require an **Entra ID P1** or **P2** license on the tenant. Basic/Free tenants return 403.

### `Authorization_RequestDenied` on PIM tools

PIM APIs require **Entra ID P2** plus the `RoleManagement.Read.Directory` / `.ReadWrite.Directory` permission.

### `Authorization_IdentityNotFound` on Intune tools

The tenant has no Intune subscription, or `DeviceManagementManagedDevices.Read.All` was not granted.

---

## Graph API runtime errors

### `429 Too Many Requests`

Microsoft Graph is throttling the app. Strategies:

- Lower `$top` via `MS365_ADMIN_MCP_MAX_TOP=25`
- Reduce parallel requests (MCP client config)
- Add `Retry-After` handling at the caller (server does not auto-retry)
- Split heavy scans across time windows

### `400 Bad Request` with `Invalid filter clause`

OData `$filter` has strict rules. Common gotchas:

- String values must be single-quoted: `userType eq 'Guest'`
- GUIDs are strings, not raw: `id eq '11111111-...'`
- `startsWith()` and `endsWith()` are case-sensitive
- Not every property is filterable (Graph API docs specify)

### `ConsistencyLevel eventual` required

Some filters (`$count`, advanced filters) need the header `ConsistencyLevel: eventual`. Currently the server does not inject this automatically — if you hit it, it's likely a Graph API change worth reporting as an issue.

### Empty response with `@odata.nextLink`

You hit a page boundary. The MCP client must follow `@odata.nextLink` manually or issue the next request with `$skiptoken`.

---

## HTTP transport

### `401 Missing or invalid Authorization header`

The request did not include `Authorization: Bearer <token>` or the header is malformed.

### `403 Token validation failed`

Common causes (enable verbose logging to see which check failed):

- Token signed by a different tenant → `Token tenant ID mismatch`
- Caller app ID not in `--allowed-clients` → `Token client ID not in allowed list`
- Token expired → JWT `exp` check
- Token audience does not match expected audience
- `kid` (signing key ID) not found in JWKS — could be a clock skew or caching issue

### `429 Too many requests, please try again later`

You exceeded 100 req/min on `/mcp` from the source IP. Either back off, reshape client behavior, or put a queue in front.

### Server not reachable from client

- Is it bound to `127.0.0.1`? Set `--host 0.0.0.0` if exposing externally (and front with TLS).
- Firewall / NSG rules blocking the port?
- Check `GET /health` from the same network as the client.

---

## Key Vault

### `DefaultAzureCredential failed to retrieve a token`

- Local dev: run `az login`.
- Azure-hosted: ensure the managed identity exists and is assigned to the compute resource.
- The identity has no `get` secret permission on the vault.

### `KeyVaultError: (Forbidden)`

RBAC or access policy missing. Grant the identity `Key Vault Secrets User` role (RBAC) or `Get` on secrets (access policies).

---

## Tool inspection

### `list-tools` shows fewer tools than expected

- Did you pass `--read-only` (the default)? Write tools are excluded.
- Did you pass `--preset`? Only matching tools load.
- Did you set `ENABLED_TOOLS`? It filters further.

### A write tool is unavailable even with `--allow-writes`

- It may be filtered out by your `--preset` regex. Check the preset's pattern in `src/tool-categories.ts`.
- For Intune report tools (POST-based but effectively read): they require `--allow-writes` because they use POST. This is expected.

---

## Claude Desktop / Claude Code integration

### The server does not start when Claude Desktop launches it

- Check Claude Desktop logs: `~/Library/Logs/Claude/` (macOS) or `%APPDATA%\Claude\Logs\` (Windows).
- Ensure `command` is `node` and `args[0]` is the absolute path to `dist/index.js`.
- Env vars in the MCP config are not read from your shell — declare them explicitly under `env`.

### Tools appear but every call errors

- Run `--verify-login` with the same env vars Claude Desktop uses.
- If env vars come from a secret manager, ensure your MCP config doesn't use shell expansion (it doesn't run a shell).

---

## Getting help

1. Run with `-v` and capture the log output.
2. Redact secrets (`MS365_ADMIN_MCP_CLIENT_SECRET`, any bearer token).
3. File an issue at [github.com/okapi-ca/ms-365-admin-mcp-server/issues](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues) with:
   - Version / commit SHA
   - Command line
   - Sanitized log excerpt
   - Expected vs actual behavior

For **security** issues, see [SECURITY.md](../SECURITY.md) — do not open a public issue.
