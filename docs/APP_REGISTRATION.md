# Azure AD App Registration Guide

This guide walks through creating an Entra ID (Azure AD) app registration with the **application permissions** required by `ms-365-admin-mcp-server`.

> This server uses the **client credentials flow** (no user sign-in). It requires a single-tenant registration and admin consent for every permission it uses.

## Prerequisites

- A Microsoft 365 tenant you administer
- **Global Administrator** or **Cloud Application Administrator** role (to create the app)
- **Global Administrator** or **Privileged Role Administrator** (to grant admin consent for privileged scopes like `RoleManagement.ReadWrite.Directory`)

## Step 1. Create the app registration

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com).
2. Navigate to **Identity** → **Applications** → **App registrations** → **New registration**.
3. Fill in:
   - **Name.** `ms-365-admin-mcp-server` (or any descriptive name)
   - **Supported account types.** `Accounts in this organizational directory only (single tenant)`
   - **Redirect URI.** Leave blank — this flow does not use redirects.
4. Click **Register**.
5. Note the **Application (client) ID** and **Directory (tenant) ID** from the Overview blade.

## Step 2. Create a client secret (or certificate)

### Option A — Client secret (simplest, 2-year max lifetime)

1. In the app blade, go to **Certificates & secrets** → **Client secrets** → **New client secret**.
2. Description: `mcp-server`. Expires: **6 months** or **12 months** (shorter is safer; plan rotation).
3. Click **Add**. **Copy the `Value` immediately** — it is shown only once.

### Option B — Certificate (recommended for production)

1. Generate a self-signed certificate:

   ```bash
   openssl req -x509 -newkey rsa:2048 -keyout mcp-key.pem -out mcp-cert.pem \
     -days 365 -nodes -subj "/CN=ms-365-admin-mcp-server"
   ```

2. Upload `mcp-cert.pem` in **Certificates & secrets** → **Certificates** → **Upload certificate**.
3. Note the thumbprint.

> Certificate-based auth is planned for a future release of this server. For now, use a client secret stored in Azure Key Vault.

### Option C — Managed Identity (Azure-hosted only)

When running in Azure Container Apps, Container Instances, or VMs, use a system-assigned managed identity and grant it Graph permissions directly. No secret to rotate. See [docs/HTTP_DEPLOYMENT.md](HTTP_DEPLOYMENT.md).

## Step 3. Add Graph API application permissions

1. In the app blade, go to **API permissions** → **Add a permission** → **Microsoft Graph** → **Application permissions**.
2. Select each permission required by the tools you intend to use.

To list exactly what's needed for your configuration:

```bash
# All read-only permissions (default mode)
node dist/index.js --list-permissions

# Only what a specific preset requires
node dist/index.js --preset identity,security --list-permissions

# Read + write for a preset
node dist/index.js --preset response --allow-writes --list-permissions
```

The full read-only and write permission lists are also documented in [README.md](../README.md#azure-ad-permissions).

3. Click **Add permissions**.
4. Click **Grant admin consent for <tenant>** and confirm. **This step is mandatory** — until admin consent is granted, Graph API calls will fail with `AADSTS65001` (no consent).

## Step 4. Verify

Set the environment variables locally and run the verify command:

```bash
export MS365_ADMIN_MCP_CLIENT_ID=<application-client-id>
export MS365_ADMIN_MCP_CLIENT_SECRET=<secret-value-from-step-2>
export MS365_ADMIN_MCP_TENANT_ID=<directory-tenant-id>

node dist/index.js --verify-login
```

Expected output:

```json
{
  "success": true,
  "message": "Connected to tenant: Contoso",
  "tenantInfo": { "displayName": "Contoso", "id": "..." }
}
```

If `success: false`, see [docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md#authentication).

## Step 5. Narrow the permission scope (optional but recommended)

The default set includes every permission required by every tool the server exposes. Run `--list-permissions` for the exact set — the tool count moves with every release, so it is not repeated here. For a specific use case, grant only what's needed:

1. Decide on the preset(s) you'll use (e.g., `identity,security`).
2. Run `--list-permissions --preset identity,security` and grant only those.
3. Start the server with matching `--preset identity,security`.
4. If you later need more, add permissions incrementally and re-consent.

This keeps the blast radius of a leaked secret bounded.

## Step 6. Protect the app

- **Owner assignment.** Add at least two named owners to the app (not just the service account that created it).
- **Authentication → Allow public client flows.** Keep this **disabled**. Client credentials do not need it.
- **Token configuration.** No optional claims are required.
- **Expose an API.** Not needed for this server (it consumes Graph, does not expose its own API) — unless you are the one using HTTP mode with `--allowed-clients`; see below.
- **App roles.** Not needed.
- **App manifest.** Set `"signInAudience": "AzureADMyOrg"` if not already.

## App registration for HTTP transport clients

If you run the server with `--transport http`, **callers** (MCP clients connecting to the server) must also have their own app registration. The server's `--allowed-clients` flag lists the Entra app IDs of authorized callers.

1. Create a separate app registration per caller (e.g., one per agent host).
2. Under **Expose an API** or **API permissions** of the caller app, configure whatever is needed to obtain a token with audience matching your server's Application ID URI.
3. Start the server with `--allowed-clients client-id-1,client-id-2`.
4. The caller obtains a token via client credentials (or another flow), then sends it as `Authorization: Bearer <token>` on `/mcp` requests.

Token validation verifies:

- RS256 signature via Microsoft JWKS (`https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys`)
- `iss` = `https://login.microsoftonline.com/<tenant>/v2.0`
- `tid` = the server's configured tenant
- `appid` or `azp` ∈ `--allowed-clients`
- `aud` = server's expected audience (if configured)

## Rotation and hygiene

- **Client secrets.** Rotate every 90 days at most. Set calendar reminders 30 days before expiry.
- **Certificates.** Renew 30 days before expiry.
- **Orphaned credentials.** Review `list-app-federated-credentials` and `add-application-password` usage quarterly. Delete unused credentials.
- **Ownership.** Audit app owners in your access reviews (use this server to do so).

## Appendix — permission reference

The full list of application permissions this server can use is in [README.md](../README.md#azure-ad-permissions). Short summary:

- **Read-only base (~70 permissions).** Required for any read operation.
- **Write base (~40 additional).** Required only if you pass `--allow-writes`.
- **Exchange.ManageAsApp.** Required specifically for Exchange admin calls.
- **PIM and RoleManagement scopes.** Required for role assignment tools.
- **eDiscovery.ReadWrite.All.** Privileged — use access reviews.

Grant the minimum intersection of (your enabled tools × the permissions each tool declares).
