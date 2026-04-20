# Use Cases

Typical scenarios for using `ms-365-admin-mcp-server` through an LLM client (Claude Desktop, Claude Code, custom agent, etc.).

Each use case includes:

- **Context** — when to use it
- **Startup command** — recommended preset and flags
- **Sample prompt** — natural-language request to give the LLM
- **Key tools** — MCP tools the LLM will invoke
- **Risk** — relevant for write scenarios

> Read-only is the default. Write operations require `--allow-writes` and are annotated with a risk level (`low`, `medium`, `high`, `critical`). Use `--max-risk-level <level>` to cap the exposed tools by risk level (implies `--allow-writes`) — for example `--max-risk-level medium` enables low- and medium-risk writes but hides `critical` operations like `wipe-managed-device`.

> For end-to-end security incident response scenarios with multi-phase procedures, see the [playbooks](playbooks/README.md) catalogue.

---

## 1. Daily security monitoring

**Context.** Start-of-day triage: review open alerts, incidents, attack simulations in progress, and Secure Score trend.

**Startup command.**

```bash
node dist/index.js --preset security,compliance
```

**Sample prompt.**

> "Summarize all security alerts from the last 24 hours grouped by severity, list open incidents assigned to my team, and compare today's Secure Score against last week's."

**Key tools.** `list-security-alerts`, `list-security-incidents`, `get-security-incident`, `list-secure-scores`, `list-secure-score-controls`, `list-attack-simulations`.

---

## 2. Incident response — compromised account

**Context.** A user is suspected compromised (phishing, stolen session, impossible travel). Contain the account, revoke sessions, and confirm the risk state.

**Startup command.**

```bash
node dist/index.js --preset identity,response --allow-writes
```

**Sample prompt.**

> "User `jdoe@contoso.com` is compromised. Disable the account, revoke all active sessions, mark the user as confirmed compromised in Identity Protection, and add a note to the related security alert."

**Key tools.** `get-user`, `disable-user-account` (**critical**), `revoke-user-sessions` (**high**), `confirm-compromised-users` (**high**), `delete-user-phone-auth-method` (**high**), `add-security-alert-comment` (**low**).

---

## 3. Suspicious sign-in audit

**Context.** Investigate unusual authentications: legacy protocols, unknown locations, risky sign-ins, risk detections not yet triaged.

**Startup command.**

```bash
node dist/index.js --preset audit,identity
```

**Sample prompt.**

> "List sign-ins from the last 7 days where the location is outside Canada or the US, the client is a legacy protocol, or the risk level is medium or higher. Cross-reference with open risk detections and identify the top 5 most exposed users."

**Key tools.** `list-sign-ins`, `list-risk-detections`, `list-risky-users`, `get-risky-user`, `list-risky-user-history`, `list-user-auth-methods`.

---

## 4. Privileged identity hygiene

**Context.** Quarterly review of Entra privileged roles: who is permanently assigned, who is eligible via PIM, whether each assignment is justified.

**Startup command.**

```bash
node dist/index.js --preset identity,governance
```

**Sample prompt.**

> "For each Entra ID privileged role (Global Admin, Privileged Role Admin, Security Admin, Exchange Admin, SharePoint Admin), list permanent members and PIM-eligible members. Flag accounts that are not MFA-enrolled or have not signed in for 30+ days."

**Key tools.** `list-directory-roles`, `list-role-members`, `list-pim-eligible-assignments`, `list-pim-active-assignments`, `list-pim-role-assignment-schedules`, `list-user-auth-methods`, `list-sign-ins`.

---

## 5. Application and credential audit

**Context.** Detect expiring application secrets, undocumented federated credentials, applications without owners, or OAuth2 grants with excessive scopes.

**Startup command.**

```bash
node dist/index.js --preset identity
```

**Sample prompt.**

> "List all application registrations with a client secret or certificate expiring in the next 60 days. For each one, provide the owners, federated credentials, and OAuth2 delegated grants. Flag apps without an owner or with privileged Graph API permissions."

**Key tools.** `list-applications`, `get-application`, `list-application-owners`, `list-app-federated-credentials`, `list-service-principals`, `list-oauth2-grants`, `list-sp-delegated-permissions`.

---

## 6. Guest user governance

**Context.** Review B2B invitations, inactive guests, and external identity providers.

**Startup command.**

```bash
node dist/index.js --preset identity,governance
```

**Sample prompt.**

> "List all guest users (`userType eq 'Guest'`), filter those who have not signed in for 90+ days, and group them by invitation source domain. Also summarize the configured B2X user flows and API connectors."

**Key tools.** `list-users`, `list-invitations`, `list-identity-providers`, `list-b2x-user-flows`, `list-api-connectors`, `list-sign-ins`.

---

## 7. Intune compliance review

**Context.** Regular review of device fleet: non-compliant devices, policy deviations, outdated configurations.

**Startup command.**

```bash
node dist/index.js --preset intune --max-risk-level low
```

> Intune reports (non-compliance, per-setting, per-policy) use POST endpoints even in read mode, so `--allow-writes` (or equivalently `--max-risk-level low`) is required. `--max-risk-level low` keeps destructive Intune actions (`wipe-managed-device`, `retire-managed-device`) out of the tool surface while allowing the reports.

**Sample prompt.**

> "Generate a non-compliance report: list devices that fail at least one compliance policy, group them by OS platform and failing policy, and identify the top 10 most frequently non-compliant settings across the fleet."

**Key tools.** `list-managed-devices`, `list-compliance-policies`, `intune-device-noncompliance-report`, `intune-policy-noncompliance-summary`, `intune-compliance-setting-noncompliance-report`, `get-compliance-state-summary`.

---

## 8. Intune remote actions — lost or compromised device

**Context.** A user reports a lost mobile device. Locate it, lock it, and if needed retire or wipe it.

**Startup command.**

```bash
node dist/index.js --preset intune,identity --allow-writes
```

**Sample prompt.**

> "User `jdoe@contoso.com` lost their iPhone. Find their enrolled devices, locate the iPhone, activate remote lock, and prepare (do not execute) a retire command if the device is not recovered within 24 hours."

**Key tools.** `list-user-devices`, `get-managed-device`, `locate-managed-device` (**low**), `remote-lock-device` (**medium**), `retire-managed-device` (**high**), `wipe-managed-device` (**critical**).

> Warning: `wipe-managed-device` and `clean-windows-device` are **critical** operations and destroy user data. Always confirm with the user before executing.

---

## 9. Service health monitoring

**Context.** Incident in progress or proactive check: Microsoft service status, active issues, Message Center announcements.

**Startup command.**

```bash
node dist/index.js --preset health
```

**Sample prompt.**

> "List all active Microsoft service issues affecting Exchange Online, Teams, or SharePoint. Summarize Message Center communications from the last 7 days tagged as action-required."

**Key tools.** `list-service-health`, `list-service-issues`, `list-service-messages`.

---

## 10. Usage reports and license optimization

**Context.** Monthly governance: adoption rate per service, inactive users, inactive paid licenses.

**Startup command.**

```bash
node dist/index.js --preset reports,identity
```

**Sample prompt.**

> "Produce a consolidated usage report over 30 days for Teams, Exchange, SharePoint, and OneDrive. Cross-reference with assigned licenses and identify users holding an E5 or Business Premium license who have been inactive on all services for 30+ days."

**Key tools.** `get-teams-activity-report`, `get-email-activity-report`, `get-sharepoint-usage-report`, `get-onedrive-usage-report`, `get-m365-apps-usage-report`, `list-subscribed-skus`, `list-users`.

---

## 11. eDiscovery — legal investigation

**Context.** Formal request from Legal or HR: create a Purview eDiscovery case, identify custodians, apply a hold, scope searches.

**Startup command.**

```bash
node dist/index.js --preset ediscovery --allow-writes
```

**Sample prompt.**

> "Create an eDiscovery case named `HR-INV-2026-014`. Add users `alice@contoso.com` and `bob@contoso.com` as custodians, apply a hold on their mailbox and OneDrive, and create an initial search for messages from 2025-01-01 to 2025-12-31 containing the keyword `project-atlas`."

**Key tools.** `create-ediscovery-case` (**medium**), `create-ediscovery-custodian` (**medium**), `apply-hold-ediscovery-custodian` (**high**), `create-ediscovery-search` (**medium**), `list-ediscovery-searches`.

> Note: check internal legal authorization before applying a hold. A hold blocks deletion and retention of the user's content.

---

## 12. SharePoint administration

**Context.** Audit sites with excessive external permissions, unused sites, or risky tenant-level settings.

**Startup command.**

```bash
node dist/index.js --preset sharepointadmin
```

**Sample prompt.**

> "List the top 20 SharePoint sites by storage, and for each list external permissions (guest users, anonymous links). Also pull tenant settings related to external sharing and flag those that do not follow least-privilege."

**Key tools.** `get-sharepoint-settings`, `list-sharepoint-sites`, `get-sharepoint-site`, `list-site-permissions`, `get-site-permission`, `get-site-analytics`.

---

## 13. Advanced threat hunting

**Context.** Investigate an IOC (indicator of compromise), IP address, suspicious domain, or behavioral pattern across Defender signals.

**Startup command.**

```bash
node dist/index.js --preset security,response --allow-writes
```

> `run-hunting-query` is an execution tool (POST) but classified **low** because it is read-only in practice (executes a KQL query, does not modify state).

**Sample prompt.**

> "Run an advanced hunting query to identify all sign-ins or executions originating from the IP `203.0.113.42` in the last 14 days. Cross-reference with threat intelligence articles mentioning this IP and enrich with WHOIS and passive DNS records."

**Key tools.** `run-hunting-query` (**low**), `list-threat-intel-articles`, `list-threat-intel-hosts`, `get-threat-intel-host-whois`, `list-passive-dns-records`, `list-threat-intel-ssl-certs`.

---

## 14. Access reviews and lifecycle workflows

**Context.** Entra ID governance: audit ongoing access reviews, apply decisions, check automated join/mover/leaver workflows.

**Startup command.**

```bash
node dist/index.js --preset governance --allow-writes
```

**Sample prompt.**

> "List all ongoing access review instances, summarize decisions already recorded (approved / denied / not reviewed), and send reminders for reviews closing in the next 3 days. Also list configured lifecycle workflows and their most recent run status."

**Key tools.** `list-access-review-instances`, `list-access-review-decisions`, `send-reminder-access-review` (**low**), `apply-access-review-decisions` (**high**), `list-lifecycle-workflows`, `get-lifecycle-workflow`.

---

## 15. Conditional Access — audit and deployment

**Context.** Review existing Conditional Access policies, detect coverage gaps (users/apps not covered), deploy a new policy from a template.

**Startup command.**

```bash
# Read-only audit
node dist/index.js --preset identity

# Write (policy creation/update)
node dist/index.js --preset identity --allow-writes
```

**Sample prompt (audit).**

> "List all Conditional Access policies, identify those in `report-only` mode for 30+ days, and detect applications (service principals) not covered by any policy requiring MFA."

**Sample prompt (deploy).**

> "Create a Conditional Access policy named `CA-Block-Legacy-Auth` that blocks legacy authentication (ActiveSync, IMAP, POP, SMTP) for all users except the `break-glass` group. Deploy it in `report-only` mode initially."

**Key tools.** `list-conditional-access-policies`, `get-conditional-access-policy`, `list-named-locations`, `list-conditional-access-templates`, `create-conditional-access-policy` (**high**), `update-conditional-access-policy` (**high**), `create-named-location` (**medium**).

> Always deploy a new CA policy in `enabledForReportingButNotEnforced` first. A misconfigured policy can lock out all users, including admins. Keep a break-glass account excluded from every policy.

---

## General recommendations

### Least-privilege preset

Do not load `--preset all` by default. Each preset loads fewer tools in the LLM context, which:

- reduces the risk of unintended invocations,
- improves LLM tool-selection accuracy,
- lowers cost (context tokens).

### Read-only by default

Always start read-only. When mutations are required, prefer `--max-risk-level <level>` over `--allow-writes` to cap at the lowest level that unlocks the scenario (e.g. `medium` for most incident-response flows; reserve `critical` for deliberate retire/wipe/delete work). Combine with `ENABLED_TOOLS` (regex) for even finer filtering.

### Validate before writing

For any `high` or `critical` tool, instruct the LLM to:

1. dry-run (list affected entities),
2. confirm with the operator,
3. then execute.

Example prompt pattern:

> "Before disabling the account, show me the user's details, their last 5 sign-ins, and their group memberships. Wait for my confirmation before calling `disable-user-account`."

### Traceability

All writes are logged by Graph API (directory audits, Intune audit events, CA policy audits, Cloud PC audit events). After an incident response, always produce a report by querying `list-directory-audits` or `list-intune-audit-events` filtered on the operation window.

### Automate tenant-specific limits

Use `MS365_ADMIN_MCP_MAX_TOP` to cap paging and avoid scan timeouts on large tenants (>10k users or >50k devices).
