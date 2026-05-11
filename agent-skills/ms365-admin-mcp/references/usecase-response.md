# usecase-response — Incident response and containment

**When to load:** suspected or confirmed account compromise, session revocation, auth method removal, compromised/safe marking in Identity Protection.

This is the **most dangerous file** in the skill — most tools are `high` or `critical`. The authoritative procedures are in the upstream playbooks; this file is a structured router.

**Upstream references:**

- [`docs/playbooks/compromised-account.md`](../../../docs/playbooks/compromised-account.md) — end-to-end procedure.
- [`docs/playbooks/oauth-illicit-consent.md`](../../../docs/playbooks/oauth-illicit-consent.md) — when the compromise involves a malicious OAuth app.
- [USE_CASES.md §2 Incident response — compromised account](../../../docs/USE_CASES.md).

## Containment sequence

```
Identify → Dry-run (account info) → Confirm → Disable → Revoke → Confirm compromised → Audit → Ticket
```

## Tools in scope

| Tool                                     | Risk         | Effect                                                                    |
| ---------------------------------------- | ------------ | ------------------------------------------------------------------------- |
| `disable-user-account`                   | **critical** | Blocks all auth for the account. Immediate.                               |
| `revoke-user-sessions`                   | **high**     | Invalidates all refresh tokens — user must re-auth everywhere.            |
| `confirm-compromised-users`              | **high**     | Marks the user `compromised` in Identity Protection, elevates risk level. |
| `confirm-safe-users`                     | **high**     | Inverse: marks `safe` (false positive).                                   |
| `dismiss-risky-users`                    | **high**     | Closes the `risky` status without further investigation.                  |
| `delete-user-phone-auth-method`          | **high**     | Removes a compromised phone auth method (SIM-swap response).              |
| `confirm-compromised-service-principals` | **high**     | Same for an SP.                                                           |
| `dismiss-risky-service-principals`       | **high**     | Closes the SP risky status.                                               |
| `update-device`                          | **high**     | Disable a device in Entra.                                                |
| `add-security-alert-comment`             | low          | Document the action in the originating alert.                             |
| `run-hunting-query`                      | low          | KQL investigation — read-only in practice; see `usecase-threatintel.md`.  |

All writes above require `--allow-writes`.

## Mandatory pattern for ANY response action

```
1. get-user                  ← Confirm identity, role, last sign-in
2. list-sign-ins             ← Reconstruct timeline (IPs, devices, apps)
3. list-user-auth-methods    ← Active MFA methods
4. list-user-memberships     ← Privileged role check
5. [PRESENT BILAN]           ← Clear recap to operator
6. [REQUEST CONFIRMATION]    ← Explicit, per tool
7. EXECUTE ONE TOOL AT A TIME
8. list-directory-audits     ← Verify the audit trail
9. add-security-alert-comment ← Annotate the source alert
10. CREATE INCIDENT TICKET   ← In your tracker
```

**Never chain multiple `high` / `critical` writes without confirmation between each.**

## Use case 1 — Standard user account compromise

> _"`jdoe@contoso.com` clicked a phishing link — contain the account."_

### Step 1 — Dry-run bilan

```
get-user(userId="jdoe@contoso.com")
list-sign-ins($filter="userPrincipalName eq 'jdoe@contoso.com' and createdDateTime ge <-7d>", $top=20)
list-user-auth-methods(userId="jdoe@contoso.com")
list-user-memberships(userId="jdoe@contoso.com")
```

Present:

- Identity confirmed (displayName, jobTitle, manager).
- **Privileged account? → if YES, STOP and escalate.** See "Privileged account" below.
- Suspicious sign-ins (timestamp, IP, location, app).
- MFA methods in place.
- Groups / roles.

### Step 2 — Confirmation

> "I'll execute in this order, confirming each step:
>
> 1. `disable-user-account` (critical) — blocks all auth immediately.
> 2. `revoke-user-sessions` (high) — forces re-auth everywhere.
> 3. `confirm-compromised-users` (high) — raises the risk level.
>
> Confirm step 1?"

### Step 3 — Sequential execution, one step at a time

After each step: display the result, ask confirmation for the next.

### Step 4 — Audit and ticket

```
list-directory-audits($filter="activityDateTime ge <now -10min> and targetResources/any(t: t/userPrincipalName eq 'jdoe@contoso.com')")
add-security-alert-comment(...)
```

Create an incident ticket in your tracker.

## Use case 2 — Privileged or admin account compromise

**STOP. Do not execute any action via MCP.**

The tenant lockout risk is too high. Standard response:

> "The targeted account is privileged (role `<role>`). This operation requires immediate escalation through your formal incident response process before any action via MCP. I can prepare the full dry-run for your team."

Prepare the dry-run (step 1 above) and format it for fast transmission. Do not call `disable-user-account` or equivalents.

## Use case 3 — Compromised service principal

> _"SP `app-xyz` has anomalous activity."_

```
get-service-principal(id=...)
list-sp-app-role-assignments(...)
list-sp-delegated-permissions(...)
list-sign-ins($filter="appId eq '<sp-app-id>'", $top=50)
```

If compromise is confirmed:

- `confirm-compromised-service-principals` (high) — confirmation required.
- Rotate SP credentials: see `usecase-identity.md` (`remove-application-password`, `add-application-password` — high).
- **Never `delete-service-principal`** without escalation (critical, can break integrations).

For the full playbook (including the disable-SP-before-revoke-sessions ordering), see [`docs/playbooks/oauth-illicit-consent.md`](../../../docs/playbooks/oauth-illicit-consent.md).

## Ticket template

Tracker-agnostic minimum:

```
Title: [INC] Account compromise — <UPN> — <YYYY-MM-DD>
Priority: High (or Critical if privileged account, sensitive data, or lateral movement)

## Context
- Detection source (alert ID, SOC signal, user report)
- Initial timeline

## Targeted account
- UPN, displayName, department, manager
- Privileged roles / groups: yes/no

## Indicators
- Suspicious sign-ins: <summary>
- Unusual IPs / devices / apps
- Potentially compromised MFA methods

## Containment actions executed
- [HH:MM] disable-user-account → <result>
- [HH:MM] revoke-user-sessions → <result>
- [HH:MM] confirm-compromised-users → <result>
- [HH:MM] delete-user-phone-auth-method (if applicable) → <result>

## Audit trail
<list-directory-audits output or reference IDs>

## Follow-up
- [ ] User communication (manager? HR?)
- [ ] Password reset + new MFA registration
- [ ] Conditional reactivation
- [ ] Lessons learned
```

## Guardrails

- **No action on break-glass accounts** under any circumstance without out-of-band sign-off.
- **No action on admin accounts** (Global, Privileged Role, Security, Exchange, SharePoint, Intune) without out-of-band sign-off.
- **Executive accounts** (CEO, CFO, CHRO, etc.): escalation required even when the account isn't admin — business and communication impact.
- **One mutation at a time.** No automated pipeline of critical actions without confirmation between each.
- **Document in the source alert immediately** via `add-security-alert-comment` after each action — not at the end of the process.

## Crosswalk

- Account identification → `usecase-identity.md`.
- Timeline reconstruction → `usecase-audit.md`.
- Related IOC investigation → `usecase-threatintel.md`.
- Concurrent device compromise → `usecase-intune.md` (locate, lock, retire).
- Legal preservation (potential litigation) → `usecase-ediscovery.md`.
