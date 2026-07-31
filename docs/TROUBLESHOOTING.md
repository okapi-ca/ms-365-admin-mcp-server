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

### `Could not resolve host` / DNS lookup fails (VNet-integrated CAE)

Symptom: `npx ms-365-admin-mcp-auth --server https://...` or a plain `curl https://.../health` fails with **Could not resolve host: `<cae-name>.<env-subdomain>.canadacentral.azurecontainerapps.io`** even though the VPN is connected.

**Context.** When the Container App Environment is VNet-integrated and `internal: true`, the CAE only has a private IP (e.g. `<cae-private-ip>`) reachable through the corporate VPN. DNS resolution for `<env-subdomain>.canadacentral.azurecontainerapps.io` comes from a **Private DNS Zone** linked to the hub VNet, which your VPN profile is supposed to push as your DNS server.

**Quick diagnostic — force the DNS query through the VPN-pushed server**

Windows PowerShell:

```powershell
# Replace <hub-dns-ip> with your hub DNS server IP. Find yours via:
#   Get-NetIPConfiguration | Where-Object InterfaceAlias -Match 'VPN' | Select DnsServer
Resolve-DnsName <your-app>.<env-subdomain>.canadacentral.azurecontainerapps.io -Server <hub-dns-ip>
```

macOS / Linux:

```bash
# Get your VPN's pushed DNS first:
#   scutil --dns | grep -A2 'resolver #' | head
dig @<hub-dns-ip> <your-app>.<env-subdomain>.canadacentral.azurecontainerapps.io
```

**Interpretation**

- **Resolution succeeds with `-Server`/`@` but fails without it** → your OS is using a different DNS server than the VPN pushed. Classic causes:
  - Hand-edited VPN profile (old troubleshooting sessions) that pinned public DNS instead of the VPN-pushed one.
  - A local DNS override in the OS (Windows: `Get-DnsClientServerAddress`; macOS: `System Settings > Network > VPN > Details > DNS`).
  - Split-tunnel DNS config where `canadacentral.azurecontainerapps.io` isn't routed through the VPN's resolver.

  **Fix**: download a fresh VPN configuration from the Azure portal (Virtual Network Gateway → Point-to-site configuration → Download VPN client) and replace your local profile. The fresh profile pushes the correct DNS server for the private DNS zone.

- **Resolution fails even with `-Server`/`@`** → the VPN itself is missing routes, or the Private DNS Zone isn't linked to the hub VNet. Not a client-side issue — escalate to the infra owner (who provisioned the CAE + Private DNS zone).

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

## OAuth / browser authentication problems

### `Server disconnected` in Claude Desktop with an HTTP-mode MCP

This usually means `mcp-remote`'s OAuth flow failed before it could hand a bearer token to Claude Desktop. Common causes:

1. **macOS Platform SSO intercepts the flow.** The Microsoft Enterprise SSO extension injects a PRT into WebKit (Safari) and sometimes Firefox, hijacking the redirect to Entra's broker. Symptom: the OAuth page loads but the `localhost:14543/oauth/callback` redirect never fires.
2. **Stale / incompatible cached tokens.** After a server-side OAuth fix, the refresh token cached in `~/.mcp-auth/mcp-remote-*/` can no longer be redeemed.
3. **Port 14543 already bound.** Another process holds the callback port.

**Quick fixes (in order)**

```bash
# 1. Purge the cache so mcp-remote does a fresh flow
rm -rf ~/.mcp-auth/mcp-remote-*

# 2. Fully quit Claude Desktop (⌘Q) and relaunch

# 3. If Platform SSO keeps intercepting, use the device_code bootstrap
#    (see below). This bypasses the browser entirely.
```

**Debug logs**

```bash
ls ~/Library/Logs/Claude/mcp-server-ms-365-admin.log
ls ~/.mcp-auth/mcp-remote-*/        # *_debug.log is mcp-remote's own log
```

### Device code flow — bypass the browser entirely

When the browser path is blocked (Platform SSO, headless Docker, remote SSH, devcontainer, GitHub Codespaces, any admin machine without a working browser), use the device_code bootstrap. The server exposes RFC 8628's `device_authorization_endpoint` since v0.6.0; the `ms-365-admin-mcp-auth` binary shipped alongside pre-seeds `mcp-remote`'s cache so Claude Desktop / Claude Code never needs to open a browser.

```bash
npx @okapi-ca/ms-365-admin-mcp-server@latest auth \
  --server https://your-mcp-host.azurecontainerapps.io/mcp
```

The helper will:

1. Register a fresh DCR client against the MCP server.
2. Request a device code from Entra via the server's `/devicecode` proxy.
3. Print a URL + user code (and copy the code to your clipboard on macOS / Linux / Windows).
4. Poll `/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` until you complete the sign-in **on any trusted device** (phone, another laptop — wherever MFA works).
5. Write `<hash>_client_info.json` and `<hash>_tokens.json` into `~/.mcp-auth/mcp-remote-<version>/` with mode `0600`.

Then relaunch Claude Desktop / Claude Code — `mcp-remote` finds the cache and skips the browser flow.

**Exit codes** (useful for Docker / CI wrappers):

| Code | Meaning                                                    |
| ---- | ---------------------------------------------------------- |
| 0    | Tokens written; ready for Claude Desktop                   |
| 1    | Usage error (bad flag, server without device_code support) |
| 2    | Network / upstream error                                   |
| 3    | `access_denied` or `expired_token` from Entra              |
| 4    | Poll timed out before user completed auth                  |

**Useful flags**

```
--scope <scope>              Override the OAuth scope (default: server metadata)
--cache-dir <path>           Write to a specific directory (useful for Docker bind mounts)
--mcp-remote-version <ver>   Target an older mcp-remote cache dir naming
--non-interactive            Skip clipboard copy (auto-detected when piped / under CI=true)
--timeout <seconds>          Max wait for user (default 900 = Entra TTL)
```

### Docker / remote dev envs

**Pattern A — bootstrap on host, mount cache into container (simplest)**

```bash
# On your Mac, once:
npx @okapi-ca/ms-365-admin-mcp-server@latest auth \
  --server https://your-mcp-host.azurecontainerapps.io/mcp

# Then run Claude Code in Docker with the cache mounted read-only:
docker run -it \
  -v ~/.mcp-auth:/root/.mcp-auth:ro \
  your/claude-code-image
```

**Pattern B — bootstrap inside a container**

```bash
docker run -it --rm \
  -v mcp-auth:/root/.mcp-auth \
  node:22-alpine \
  npx @okapi-ca/ms-365-admin-mcp-server@latest auth \
    --server https://your-mcp-host.azurecontainerapps.io/mcp

# Subsequent Claude Code containers reuse the same named volume:
docker run -it -v mcp-auth:/root/.mcp-auth your/claude-code-image
```

**Conditional Access caveat** — CA policies requiring a compliant / Entra-joined device can block the device_code flow even when the user authenticates on their phone. Either exempt the MCP app registration (`86f46c1e-…` in the LCI tenant) from the CA policy, or accept that device_code only works from MDM-compliant devices.

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
