---
name: ms365-admin-mcp
description: Reference skill for operating ms-365-admin-mcp-server through an LLM client. Load when a request involves a Microsoft 365 administrative operation requiring tenant-level permissions — Defender alert triage, sign-in investigation, PIM audit, Intune actions, eDiscovery, KQL hunting, Conditional Access management, or any tenant-scoped directory operation through application (client credentials) permissions.
---

# ms365-admin-mcp

A reusable Claude Code skill that wraps `ms-365-admin-mcp-server` with a structured safety pattern: discover the right tool by use case, dry-run first, confirm explicitly, audit after. The skill is a router — its reference files index the server's 515 tools by domain and point back to the authoritative documentation in [`docs/USE_CASES.md`](../../docs/USE_CASES.md) and [`docs/playbooks/`](../../docs/playbooks/README.md).

## When to load this skill

Load this skill when the request involves a **Microsoft 365 administrative operation** requiring tenant-level permissions. Typical signals:

- "List security alerts / open incidents / risky users"
- "Audit sign-ins for…", "what changed in the directory yesterday"
- "Permanent Global Admin members", "PIM assignments"
- "Non-compliant Intune devices", "wipe the device of user X"
- "Create a Conditional Access policy", "audit current CA policies"
- "Applications with expiring secrets", "suspicious OAuth grants"
- "Run a hunting query", "threat intel on this IP"
- "Create an eDiscovery case", "apply a hold on user X's mailbox"

## When NOT to load this skill

This server uses **application permissions** (client credentials). Do not load it when the request concerns the operator's own data: their personal mailbox, calendar, OneDrive, Teams chats, or anything that should run as a connected user. Those scenarios belong to a **delegated** companion server such as [Softeria/ms-365-mcp-server](https://github.com/Softeria/ms-365-mcp-server).

| Situation                                 | Server to use             |
| ----------------------------------------- | ------------------------- |
| "Read my emails"                          | Delegated companion       |
| "List tenant message traces"              | `ms-365-admin-mcp-server` |
| "Create an event in my calendar"          | Delegated companion       |
| "List risky sign-ins for the last 7 days" | `ms-365-admin-mcp-server` |
| "Send an email to the team"               | Delegated companion       |
| "Disable user `jdoe@contoso.com`"         | `ms-365-admin-mcp-server` |

When in doubt, ask whether the operation concerns **the operator's own data** (delegated) or **the tenant / other users** (application).

## Security model — read this before every write

### Read-only by default

The server is read-only unless started with `--allow-writes`. Even when writes are enabled, treat reads as the default and route every mutation through the dry-run / confirmation / audit pattern below.

### Risk levels

Every write tool is classified `low` / `medium` / `high` / `critical` in [`docs/RISK_MODEL.md`](../../docs/RISK_MODEL.md). Each `references/usecase-*.md` file in this skill names the tools in scope along with their risk level — consult the relevant use case file before invoking any write.

The server can be capped at startup with `--max-risk-level <level>` to hide tools above a chosen level (`--max-risk-level medium` keeps low- and medium-risk writes, hides `high` and `critical`). Recommend this when you don't need the riskier surface.

### Mandatory pattern for `high` and `critical` tools

For any tool classified `high` or `critical`, follow this sequence without exception:

1. **Dry-run.** Read and display the target object (user, device, policy, app). List the expected effects in plain English.
2. **Ask for explicit confirmation,** naming the tool, the target, and the impact. Example: _"I'm about to call `disable-user-account` on `jdoe@contoso.com`. This will immediately block all sessions and authentication. Confirm?"_
3. **Wait for a clear positive confirmation** ("yes", "go", "confirmed") before invoking the write.
4. **Audit after execution** via `list-directory-audits` (or `list-intune-audit-events` for device actions) filtered to the operation's time window.

A vague reply ("ok", "sure") is not sufficient for a `critical` tool — ask again explicitly.

### Tools to escalate before invoking, even with operator confirmation

These are classified `critical` and have tenant-wide blast radius. The operator's confirmation in chat is not enough — surface the escalation requirement and refuse to call them autonomously:

- `delete-user` — permanent account removal
- `delete-group` — group removal (cascades to license assignment, CA scoping, access)
- `delete-application`, `delete-service-principal` — can break integrations
- `delete-conditional-access-policy` — can break tenant authentication
- `delete-exchange-mailbox` — mailbox destruction
- `delete-ediscovery-case` — destroys legal evidence
- `wipe-managed-device`, `clean-windows-device` — user data destruction
- `delete-team` — team removal (30-day soft-delete window)
- `disable-user-account` on a privileged, admin, or break-glass account — tenant lockout risk
- `add-directory-role-member` for Global Admin / Privileged Role Admin — privilege elevation
- `create-pim-role-assignment-request` on a privileged role — privilege elevation

Standard response for these: _"This operation is classified `critical` and requires sign-off outside this session before execution. I can prepare the dry-run and a written change request, but I won't invoke the write tool here."_

### General guardrails

- **Conditional Access changes.** Create new policies in `enabledForReportingButNotEnforced` (report-only) first; never go straight to `enabled`. Always exclude the tenant's break-glass account from any new policy.
- **Break-glass accounts.** No mutation on these accounts under any circumstance without out-of-band sign-off.
- **Privileged accounts.** `disable-user-account`, `revoke-user-sessions`, `delete-user-phone-auth-method` on an admin or executive account need escalation, not chat confirmation.
- **Post-action traceability.** After every mutation, propose `list-directory-audits` or `list-intune-audit-events` filtered to the window, and offer to file an incident ticket in the operator's tracker.

## Navigation by use case

Load the file matching the task at hand. **Do not preload multiple files** — lazy-load one at a time.

| Use case                                                            | Reference file                          | When to use                                                  |
| ------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------ |
| Defender alert / incident triage, attack simulations                | `references/usecase-security.md`        | Daily triage, SOC escalations, attack-sim follow-up          |
| Sign-in audit, directory audits, deleted-item recovery              | `references/usecase-audit.md`           | Investigation, forensics, traceability                       |
| Compromised account investigation and containment                   | `references/usecase-response.md`        | Suspected compromise, session revocation, risk-state changes |
| Users, groups, PIM, roles, applications, guests                     | `references/usecase-identity.md`        | Identity hygiene, credential audits, B2B governance          |
| Access reviews, entitlement management, lifecycle workflows         | `references/usecase-governance.md`      | Quarterly reviews, joiner/mover/leaver automation            |
| Licenses, Secure Score, Identity Protection, Conditional Access     | `references/usecase-compliance.md`      | Posture, scoring, CA audit/deployment, risk detection triage |
| Intune devices, compliance, Autopilot, MAM, remote actions          | `references/usecase-intune.md`          | Fleet audit, lost/compromised device, MAM                    |
| Message traces, Exchange mailboxes                                  | `references/usecase-exchange.md`        | Mail delivery investigation, mailbox audit                   |
| SharePoint tenant settings, sites, permissions                      | `references/usecase-sharepointadmin.md` | External-sharing audit, site permissions                     |
| Service health, Message Center                                      | `references/usecase-health.md`          | Active incident, MS status checks                            |
| Usage reports (Teams, Email, SP, OD, M365 Apps)                     | `references/usecase-reports.md`         | License optimization, adoption metrics                       |
| eDiscovery (Purview), holds, custodians                             | `references/usecase-ediscovery.md`      | Legal/HR requests, formal investigation                      |
| Cloud PC / Windows 365                                              | `references/usecase-cloudpc.md`         | CPC provisioning, images, audits                             |
| Threat intelligence (hosts, IOCs, WHOIS, passive DNS) + KQL hunting | `references/usecase-threatintel.md`     | IOC investigation, enrichment, advanced hunting              |
| Teams call records, PSTN                                            | `references/usecase-callrecords.md`     | Call quality investigation, PSTN audit                       |
| Universal Print                                                     | `references/usecase-print.md`           | Printer inventory, usage audit                               |
| Information Protection, BitLocker, sensitivity labels               | `references/usecase-infoprotection.md`  | Key recovery, classification audit                           |
| Records management, retention                                       | `references/usecase-retention.md`       | Document retention, file plan                                |
| Teams admin (teams, channels, app policies)                         | `references/usecase-teamsadmin.md`      | Tenant-level Teams governance                                |

For end-to-end incident response procedures, refer to the upstream playbooks: [`docs/playbooks/`](../../docs/playbooks/README.md).

## Troubleshooting

### Network error / timeout on the first call

If the server is deployed behind a private network (Azure Container Apps with VNet, on-prem proxy, etc.), verify network reachability before retrying. Surface the error to the operator rather than attempting fallbacks.

### `403 Forbidden` or `Insufficient privileges`

The corresponding Graph permission has not been consented on the app registration. Document which permission is missing (Microsoft Graph docs list the required `Application` permission per endpoint) and escalate to whoever has consent rights on the tenant. See `references/graph-permissions.md` for the full list of permissions used by the server.

### `get-security-alert` (or another `get-*`) times out

Known pattern on large Defender alerts. Workaround: use `list-security-alerts` with tight filters (`$top`, `severity`, `lastModifiedDateTime`) to identify the alert, then retry `get-security-alert` with the exact ID. If it still times out, capture the essential fields from the list response and note the limitation.

### Pagination on large tenants (>10k users, >50k devices)

Always start with `$top=50` or `$top=100`. For bulk reads, paginate via `@odata.nextLink`. The server respects `MS365_ADMIN_MCP_MAX_TOP` on the config side.

### Too many tools visible, model picks the wrong one

Load the appropriate `usecase-*.md` file and stay within its named tool set. The file's "scope" table is the source of truth for that domain.

### Confusion between this server and a delegated companion

See the decision table at the top of this file. If the operation concerns the tenant or another user, it's this server. If it concerns the operator's own data, it's a delegated server.

## References

- Upstream USE_CASES: [`docs/USE_CASES.md`](../../docs/USE_CASES.md)
- Incident response playbooks: [`docs/playbooks/`](../../docs/playbooks/README.md)
- Risk classification rubric: [`docs/RISK_MODEL.md`](../../docs/RISK_MODEL.md)
- App registration setup: [`docs/APP_REGISTRATION.md`](../../docs/APP_REGISTRATION.md)
- HTTP deployment + Azure: [`docs/HTTP_DEPLOYMENT.md`](../../docs/HTTP_DEPLOYMENT.md)
- Tool risk index: `references/tools-catalog.md`
- Graph permissions: `references/graph-permissions.md`

## Metadata

- Source server: [`okapi-ca/ms-365-admin-mcp-server`](https://github.com/okapi-ca/ms-365-admin-mcp-server) (515 tools)
- Permission model: application (client credentials) — see [Acknowledgments](../../README.md#acknowledgments) for the delegated companion
- License: MIT (same as the server)
