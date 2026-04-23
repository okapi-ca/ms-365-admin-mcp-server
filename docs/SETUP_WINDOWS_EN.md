# MS 365 Admin MCP — Windows setup guide (device code flow)

Connect Claude Desktop on your Windows admin laptop to the LCI `ms-365-admin` MCP server so you can query M365 security, audit, users, groups, Intune, and Defender data through natural-language prompts.

**Who this is for:** LCI tenant admins with an `adm.aad.*@lcieducation.onmicrosoft.com` account. If your admin account isn't in the allowlist (`--authorized-users` oids configured by Marc), ask him before starting.

**Why device code:** on Windows, Edge / Chrome / Firefox all get intercepted by Microsoft's WAM broker (Web Account Manager). The standard browser-based OAuth flow won't complete. Device code flow bypasses the browser entirely — you authenticate on your phone or another device.

---

## Prerequisites

| Item                                 | How to verify                                            | If missing                                                                      |
| ------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Claude Desktop                       | `Start > Claude` opens                                   | Install from https://claude.ai/download                                         |
| Node.js 18+                          | `node --version` in PowerShell                           | Install from https://nodejs.org (LTS) or via `winget install OpenJS.NodeJS.LTS` |
| Microsoft Authenticator (or Yubikey) | Your admin account MFA is already enrolled               | Ask IT if MFA setup is incomplete                                               |
| Your admin account credentials       | `adm.aad.<your-name>@lcieducation.onmicrosoft.com` + MFA | —                                                                               |

---

## Step 1 — Configure Claude Desktop

Open PowerShell and run:

```powershell
notepad "$env:APPDATA\Claude\claude_desktop_config.json"
```

If the file doesn't exist yet, Notepad asks to create it — say yes. Paste this content (replace anything already there):

```json
{
  "mcpServers": {
    "ms-365-admin": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp"
      ]
    }
  }
}
```

Save (Ctrl+S) and close Notepad.

---

## Step 2 — Run the device code bootstrap

In PowerShell, run:

```powershell
# Make sure you're NOT inside a Node project folder (avoid local node_modules interference)
cd $env:USERPROFILE

npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth `
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp
```

(The backtick `` ` `` is PowerShell's line-continuation character. If you prefer a single line, remove the `` ` `` and put everything on one line.)

You'll see output similar to:

```
Discovering OAuth metadata at https://ca-cc-mcpms365admin-p…
Registering a fresh DCR client…
Requesting a device code…

────────────────────────────────────────────────────────────
 Microsoft 365 Admin MCP — device code authentication
────────────────────────────────────────────────────────────
 1. Open https://microsoft.com/devicelogin
 2. Enter code: XXXX-XXXX   (copied to clipboard)
 Waiting for authentication… (timeout 15 min)
────────────────────────────────────────────────────────────
```

The user code is **copied to your clipboard automatically**.

---

## Step 3 — Authenticate on your phone

1. On your phone (or any device with a working browser), go to **https://microsoft.com/devicelogin**
2. Enter the code shown in your PowerShell window (it's already in your clipboard — paste with Ctrl+V on a laptop, or the paste action on your phone).
3. Sign in with your admin account: **adm.aad.\<your-name\>@lcieducation.onmicrosoft.com**
4. Complete MFA (Authenticator app push or Yubikey).
5. Confirm the consent screen if shown.

Back in PowerShell, you'll see:

```
Authentication complete.
  cache dir:   C:\Users\<you>\.mcp-auth\mcp-remote-0.1.38
  client info: …_client_info.json
  tokens:      …_tokens.json

Restart Claude Desktop / Claude Code — mcp-remote will reuse these tokens.
```

---

## Step 4 — Restart Claude Desktop and test

1. Quit Claude Desktop completely (right-click the tray icon → Quit, or kill it via Task Manager).
2. Launch Claude Desktop from the Start menu.
3. In a new conversation, try a test prompt:

   > List the 5 most recent Defender security alerts.

   Claude should answer using the `list-security-alerts` tool from the `ms-365-admin` MCP.

---

## Reset / re-authenticate (first thing to try when something breaks)

If Claude Desktop shows "Server disconnected", tool calls fail with auth errors, or you changed account and want to re-authenticate, wipe the token cache and re-run the bootstrap:

```powershell
# 1. Quit Claude Desktop completely (tray icon → Quit, or Task Manager)

# 2. Delete the authentication cache
Remove-Item -Recurse -Force "$env:USERPROFILE\.mcp-auth\mcp-remote-*"

# 3. (Only if npx itself misbehaves — e.g. "command not found" errors)
Remove-Item -Recurse -Force "$env:USERPROFILE\.npm\_npx"

# 4. Re-run the bootstrap (Step 2 above)
cd $env:USERPROFILE
npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth `
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp

# 5. Re-launch Claude Desktop
```

This is safe — no data is lost. The cache only holds OAuth tokens; deleting it just forces a fresh authentication on next startup.

Common situations that require a reset:

- You see old data or get errors after a server upgrade
- You changed your admin password or re-registered MFA
- Your refresh token expired (Entra rotates them periodically)
- Claude Desktop was closed while in the middle of an auth flow

---

## Troubleshooting

**`ms-365-admin-mcp-auth: command not found`**
You're running from a folder that has its own `node_modules`. Go to your home directory first (`cd $env:USERPROFILE`) and retry.

**The bootstrap prints `429 Too many token requests`**
This was a bug in v0.6.0 — if you see it, confirm you're using v0.6.1 or later: `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@0.6.1" …`

**Claude Desktop shows "Server disconnected" after restart**
Check that tokens were actually written:

```powershell
dir $env:USERPROFILE\.mcp-auth\mcp-remote-*\
```

If there's no `*_tokens.json` file, the bootstrap didn't complete. Run it again.

**`AADSTS50105: Your account is not assigned to a role for the application`**
Your admin oid isn't in the server's `--authorized-users` list. Contact Marc to add it.

**Everything else**
Collect:

- `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth --help` output
- Contents of `%USERPROFILE%\.mcp-auth\mcp-remote-*\` (redact token values)
- Recent Claude Desktop log: `%APPDATA%\Claude\Logs\mcp-server-ms-365-admin.log`

Ping Marc with the above.

---

## What this MCP can do

Read-only by default. Covers:

- **Security**: Defender alerts and incidents, Identity Protection risky users, Secure Score, attack simulations, threat intelligence.
- **Audit**: directory audits, sign-ins, provisioning logs, deleted items.
- **Identity**: users, groups, directory roles, PIM eligible/active assignments, Conditional Access policies.
- **Intune**: managed devices, compliance policies, device configurations, app protection.
- **Organization**: subscribed SKUs (licenses), service health, usage reports.

Full tool list: `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-server --list-tools` — but you'll typically just ask Claude natural-language questions.

## Security notes

- Tokens are cached in `%USERPROFILE%\.mcp-auth\` and only readable by your Windows user.
- The MCP runs in read-only mode by default — no mutations possible from Claude.
- Your admin actions are audited in Entra + Purview as if you made them yourself (OBO delegated flow).
- If you leave LCI or change roles, Marc revokes your oid from `--authorized-users` server-side.
