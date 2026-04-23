# MS 365 Admin MCP — macOS setup guide

Connect Claude Desktop on your Mac to the LCI `ms-365-admin` MCP server so you can query M365 security, audit, users, groups, Intune, and Defender data through natural-language prompts.

**Who this is for:** LCI tenant admins with an `adm.aad.*@lcieducation.onmicrosoft.com` account. If your admin account isn't in the allowlist (`--authorized-users` oids configured by Marc), ask him before starting.

**Two authentication paths — pick one:**

- **Browser flow (default, easiest)** — Claude Desktop opens an OAuth tab in your default browser, you sign in, done. Works for admin accounts that aren't enrolled in Platform SSO (the common case at LCI since `adm.aad.*` accounts have no Intune license).
- **Device code flow (fallback)** — If browser flow fails (Safari intercepted by a Microsoft Enterprise SSO extension, or headless Mac), you authenticate on your phone or another device.

---

## Prerequisites

| Item                                 | How to verify                                            | If missing                                                 |
| ------------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------- |
| Claude Desktop                       | `open -a Claude` in Terminal works                       | Install from https://claude.ai/download                    |
| Node.js 18+                          | `node --version` in Terminal                             | `brew install node` (Homebrew) or https://nodejs.org (LTS) |
| Microsoft Authenticator (or Yubikey) | Your admin account MFA is already enrolled               | Ask IT if MFA setup is incomplete                          |
| Your admin account credentials       | `adm.aad.<your-name>@lcieducation.onmicrosoft.com` + MFA | —                                                          |

---

## Step 1 — Configure Claude Desktop

Open Terminal and run:

```bash
mkdir -p ~/Library/Application\ Support/Claude
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

If the file doesn't exist, TextEdit creates an empty one. Paste this content (replace anything already there):

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

Save (⌘S) and close TextEdit.

---

## Step 2 — Launch Claude Desktop (browser flow)

1. **Quit Claude Desktop** if already running (⌘Q).
2. **Relaunch** from Spotlight (⌘Space, type "Claude") or the Dock.
3. A browser tab opens automatically on `login.microsoftonline.com/...` — your default browser handles it.
4. Sign in with your admin account: **adm.aad.\<your-name\>@lcieducation.onmicrosoft.com**
5. Complete MFA (Authenticator app push or Yubikey).
6. The page redirects to `localhost:14543/oauth/callback` and shows "Authentication successful — you can close this tab."

Back in Claude Desktop, the MCP `ms-365-admin` is now connected.

**If you see "Server disconnected" or the browser tab loops on a Microsoft broker page** — Platform SSO is likely intercepting via the _Microsoft Enterprise SSO_ browser extension. Jump to the device code fallback below.

---

## Step 3 — Test

In a new conversation:

> List the 5 most recent Defender security alerts.

Claude should answer using the `list-security-alerts` tool from the `ms-365-admin` MCP.

---

## Alternative: device code flow (fallback)

Use this if Step 2 fails with "Server disconnected" or the browser tab redirects through a broker endlessly.

```bash
# 1. Quit Claude Desktop (⌘Q)

# 2. Purge the OAuth cache
rm -rf ~/.mcp-auth/mcp-remote-*

# 3. Run the device code bootstrap
cd ~
npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-auth \
  --server https://ca-cc-mcpms365admin-p.bravecliff-2d3b4e20.canadacentral.azurecontainerapps.io/mcp
```

You'll see:

```
────────────────────────────────────────────────────────────
 Microsoft 365 Admin MCP — device code authentication
────────────────────────────────────────────────────────────
 1. Open https://microsoft.com/devicelogin
 2. Enter code: XXXX-XXXX   (copied to clipboard)
 Waiting for authentication… (timeout 15 min)
────────────────────────────────────────────────────────────
```

The user code is copied to your clipboard automatically.

On your phone (or any device with a working browser), go to **https://microsoft.com/devicelogin**, paste the code, sign in with your admin account, complete MFA. Terminal prints "Authentication complete" and writes the tokens.

Relaunch Claude Desktop — `mcp-remote` picks up the cached tokens, no browser tab opens.

---

## Reset / re-authenticate (first thing to try when something breaks)

If Claude Desktop shows "Server disconnected", tool calls fail with auth errors, or you changed account and want to re-authenticate:

```bash
# 1. Quit Claude Desktop (⌘Q)

# 2. Delete the authentication cache
rm -rf ~/.mcp-auth/mcp-remote-*

# 3. (Only if npx itself misbehaves — e.g. "command not found" errors)
rm -rf ~/.npm/_npx

# 4. Relaunch Claude Desktop — the browser flow triggers fresh.
#    (If browser flow still fails, fall back to the device code steps above.)
```

This is safe — no data is lost. The cache only holds OAuth tokens; deleting it forces a fresh authentication on next startup.

Common situations that require a reset:

- You see old data or get errors after a server upgrade
- You changed your admin password or re-registered MFA
- Your refresh token expired (Entra rotates them periodically)
- Claude Desktop was closed during an in-progress auth flow

---

## Troubleshooting

**`ms-365-admin-mcp-auth: command not found` (when running device code bootstrap)**
You're in a folder that has its own `node_modules`. `cd ~` first and retry.

**Browser tab opens but redirects silently through a Microsoft broker page**
_Microsoft Enterprise SSO_ extension is installed in Safari/Chrome/Firefox. Either: disable it temporarily (`Safari > Settings > Extensions`), use a private/incognito window (extensions are disabled there by default), switch to Brave/Arc for this flow, or use the device code fallback.

**Claude Desktop shows "Server disconnected" after restart**
Check that tokens were written:

```bash
ls -la ~/.mcp-auth/mcp-remote-*/
```

If there's no `*_tokens.json` file, auth didn't complete. Run the reset + try again (device code if browser keeps failing).

**`AADSTS50105: Your account is not assigned to a role for the application`**
Your admin oid isn't in the server's `--authorized-users` list. Contact Marc.

**Everything else**
Collect:

- Recent Claude Desktop log: `~/Library/Logs/Claude/mcp-server-ms-365-admin.log`
- Contents of `~/.mcp-auth/mcp-remote-*/` (redact token values)
- Exact error text or screenshot

Ping Marc.

---

## What this MCP can do

Covers:

- **Security**: Defender alerts and incidents, Identity Protection risky users, Secure Score, attack simulations, threat intelligence.
- **Audit**: directory audits, sign-ins, provisioning logs, deleted items.
- **Identity**: users, groups, directory roles, PIM eligible/active assignments, Conditional Access policies.
- **Intune**: managed devices, compliance policies, device configurations, app protection.
- **Organization**: subscribed SKUs (licenses), service health, usage reports.
- **Write actions** (currently enabled on the pilot): `update-security-alert`, `dismiss-risky-user`, `revoke-user-sessions`, etc. Claude uses your permissions via OBO, so nothing escalates beyond what your account can already do. Sensitive roles stay gated behind PIM.

Full tool list: `npx -y -p "@okapi-ca/ms-365-admin-mcp-server@latest" ms-365-admin-mcp-server --list-tools` — but you'll typically just ask Claude natural-language questions.

## Security notes

- Tokens are cached in `~/.mcp-auth/` with `0600` permissions (user-readable only).
- Your admin actions are audited in Entra + Purview under your UPN as if you made them yourself (OBO delegated flow).
- High-risk roles (Global Admin, User Access Admin, Privileged Role Admin) stay PIM-protected — tool availability in Claude doesn't bypass role activation requirements.
- If you leave LCI or change roles, Marc revokes your oid from `--authorized-users` server-side.
