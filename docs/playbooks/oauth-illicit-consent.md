# Playbook — OAuth Illicit Consent (Consent Phishing)

End-to-end response to a malicious OAuth application that has obtained delegated or application permissions in the tenant. Unlike credential phishing, the attacker holds a **refresh token**, not a password — session revocation and MFA reset do not, by themselves, remove access. The service principal must be neutralised.

Scope note: this admin server can perform the **full loop** (scope, contain, harden, document) without external handoff. This is the contrast point versus the [phishing playbook](phishing-tenant-wide.md).

---

## Background

Consent phishing: the attacker sends a link to a Microsoft consent screen for an OAuth application they control. The user clicks _Accept_ and grants delegated scopes like `Mail.Read`, `Files.Read.All`, `offline_access`. The attacker receives an access token + refresh token for that user. A tenant admin variant asks for admin consent on `AllPrincipals`, gaining access to every user in one click.

Key properties:

- **Password rotation does not help** — OAuth tokens are independent of password state.
- **MFA does not help** — MFA was already satisfied at consent time.
- **Session revocation alone is insufficient** — a revoked session does not invalidate an already-issued refresh token tied to an app-grant on the service principal.
- **Correct remediation is service-principal-scoped**: disable or delete the SP, then revoke sessions.

---

## Trigger signals

- Service principal appears in `list-risky-service-principals` with `riskLevel = high`.
- Defender / Identity Protection alert referencing a suspicious OAuth application.
- A user reports they clicked _Accept_ on an unexpected consent screen.
- Spike of Graph API calls by a newly-created service principal (see `list-sign-ins` filtered on `appDisplayName`).
- A pending request in `list-app-consent-requests` from an unknown publisher.

---

## Prerequisites

### Presets

- **Investigation (read-only)**
  ```bash
  node dist/index.js --preset identity,audit,security,compliance
  ```
- **Containment (writes)**
  ```bash
  node dist/index.js --preset identity,audit,security,compliance,response --allow-writes
  ```

### Delegated permissions (minimum)

- `Application.ReadWrite.All` — to update / delete service principals.
- `Directory.Read.All`, `AuditLog.Read.All`
- `IdentityRiskyServicePrincipal.ReadWrite.All`
- `DelegatedPermissionGrant.ReadWrite.All`
- `SecurityAlert.ReadWrite.All`, `SecurityIncident.ReadWrite.All`

See [APP_REGISTRATION.md](../APP_REGISTRATION.md).

---

## Phase 1 — Identify the malicious application

Goal: go from the signal to a full profile of the suspect service principal.

| #   | Objective                          | MCP tool(s)                                                             | Notes                                                                                                                                                    |
| --- | ---------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pull the service principal profile | `get-service-principal`                                                 | `appId`, `publisherName`, `verifiedPublisher`, `signInAudience`, `createdDateTime`. Newly created + unverified publisher + multi-tenant = strong signal. |
| 2   | Check registered credentials       | `list-app-federated-credentials`                                        | Federated credentials are a modern persistence vector. Any FIC added recently is suspicious.                                                             |
| 3   | Check ownership                    | `list-service-principal-owners`, `list-application-owners`              | A compromised internal user who owns a suspicious app is a secondary compromise.                                                                         |
| 4   | Pull risk detections on the SP     | `list-service-principal-risk-detections`, `get-risky-service-principal` | Microsoft-flagged risky behaviours (leaked credentials, anomalous activity).                                                                             |
| 5   | Find the home application object   | `get-application`                                                       | Only present if the app is registered in _this_ tenant (single-tenant or multi-tenant publisher = home tenant).                                          |

### Sample prompt

> "Profile the service principal with objectId `<spObjectId>`: publisher, sign-in audience, creation date, federated credentials, owners, related risk detections, and (if registered here) the home application object. Flag every indicator of a newly-created, unverified, multi-tenant app."

---

## Phase 2 — Measure blast radius

Goal: enumerate every grant this service principal holds, and every user affected.

| #   | Objective                               | MCP tool(s)                     | Notes                                                                                                                                                                                                       |
| --- | --------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6   | Enumerate delegated permission grants   | `list-oauth2-grants`            | Filter `clientId eq '<spObjectId>'`. Each result: `principalId` (user who consented), `scope` (space-separated). `consentType = AllPrincipals` means tenant-wide admin consent — blast radius = every user. |
| 7   | Enumerate application permission grants | `list-sp-app-role-assignments`  | App-only permissions (e.g. `Mail.Read` as application) — no user interaction needed, attacker can call Graph on every mailbox. Highest severity.                                                            |
| 8   | List configured delegated permissions   | `list-sp-delegated-permissions` | What scopes _could_ the SP request — baseline for Phase 4 policy tightening.                                                                                                                                |
| 9   | Who actually authenticated to it        | `list-sign-ins`                 | Filter `appDisplayName eq '<malicious app>'` over the window since creation. Gives the real list of active victims, separate from the consented list.                                                       |
| 10  | Consent event timeline                  | `list-directory-audits`         | Filter on `activityDisplayName in ('Consent to application', 'Add app role assignment grant to service principal')` and the SP's `targetResources`. Produces the forensic timeline.                         |

### Severity classification

- **Critical** — one or more `list-sp-app-role-assignments` entries (application permissions). Whole tenant exposed.
- **High** — `list-oauth2-grants` with `consentType = AllPrincipals` on sensitive scopes (`Mail.ReadWrite`, `Files.ReadWrite.All`, `User.Read.All`).
- **Medium** — per-user delegated consent on sensitive scopes by more than a handful of users, or by any privileged user.
- **Low** — per-user delegated consent on low-impact scopes (`User.Read`, `openid`, `profile`, `offline_access` alone).

---

## Phase 3 — Containment

Order matters. Neutralise the SP **before** revoking user sessions — otherwise the attacker uses the remaining refresh-token window to re-consent on fresh sessions or pivot.

| #   | Action                                                   | MCP tool                                                 | Risk         | Effect                                                                                                                    |
| --- | -------------------------------------------------------- | -------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 11  | Soft-block the service principal                         | `update-service-principal` with `accountEnabled = false` | **high**     | Prevents all new token issuance. Preserves the audit trail and the grants themselves for forensics. Preferred first step. |
| 12  | Strip attacker-added credentials                         | `remove-sp-key`, `remove-sp-password`                    | **high**     | If credentials were added post-compromise, remove them. Do not remove credentials you cannot correlate to the attacker.   |
| 13  | Remove rogue owners                                      | `remove-sp-owner`                                        | **medium**   | If an internal user owns the malicious SP and is confirmed complicit / compromised.                                       |
| 14  | Mark as confirmed compromised                            | `confirm-compromised-service-principals`                 | **high**     | Feeds Identity Protection, triggers dependent Conditional Access policies for SPs.                                        |
| 15  | Revoke affected user sessions                            | `revoke-user-sessions`                                   | **high**     | For every user in steps 6 and 9. Kills active access tokens.                                                              |
| 16  | Delete the service principal (optional, after forensics) | `delete-service-principal`                               | **critical** | Only after evidence preservation. Destroys the SP object and all grants. Irreversible.                                    |

> The compromised-account playbook is triggered for each user who consented to sensitive scopes — especially those whose sign-ins in step 9 show attacker-infrastructure IPs.

### Sample containment prompt

> "Containment for service principal `<spObjectId>`. Dry-run every write first:
>
> 1. Set `accountEnabled = false` on the SP.
> 2. List any secret/key added after `<creation date + 1 day>` and propose removal.
> 3. Mark the SP as confirmed compromised.
> 4. Revoke sessions for every user identified in Phase 2 steps 6 and 9.
>
> Wait for my explicit confirmation before each write. Do not delete the SP yet — flag it for post-forensics cleanup."

---

## Phase 4 — Harden to prevent recurrence

The single highest-leverage control against consent phishing is **restricting user consent**.

| #   | Objective                                           | MCP tool(s)                                               | Action                                                                                                                  |
| --- | --------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 17  | Review the tenant's consent policy                  | `list-permission-grant-policies`                          | Confirm which app-role / delegated scopes users can consent to without admin approval. Default is often too permissive. |
| 18  | Review outstanding consent requests                 | `list-app-consent-requests`, `list-user-consent-requests` | Clear the queue; look for other suspicious pending requests from the same attacker.                                     |
| 19  | Recommend the admin-consent workflow if not enabled | _(read-only — configuration change is out of MCP scope)_  | Directs any consent for risky scopes to admin review. Biggest prevention win.                                           |

---

## Phase 5 — Documentation and audit

| #   | Action                       | MCP tool                     | Notes                                                                                  |
| --- | ---------------------------- | ---------------------------- | -------------------------------------------------------------------------------------- |
| 20  | Update the security incident | `update-security-incident`   | Classification `truePositive / maliciousApp`, status `resolved` once Phase 3 complete. |
| 21  | Narrative on the alert       | `add-security-alert-comment` | Chronology + scope summary + containment steps.                                        |
| 22  | Investigation audit log      | `list-directory-audits`      | Filter on the responder, response window. Attach to the incident.                      |

---

## Full-run demo prompt (single-shot)

> "Service principal `<spObjectId>` was just flagged as risky high. Run the OAuth illicit consent playbook:
>
> 1. Profile — pull SP details, federated credentials, owners, risk detections, and the home application if it exists. Flag every newly-created / unverified / multi-tenant indicator.
> 2. Blast radius — enumerate delegated grants, application permission assignments, all sign-ins to this app, and the consent event timeline. Classify severity (critical / high / medium / low).
> 3. Containment — wait for my confirmation before each write: soft-block the SP, strip credentials added post-compromise, mark as confirmed compromised, revoke sessions of every affected user. Do not delete the SP yet.
> 4. Hardening — summarize the tenant permission-grant policy and outstanding consent requests; recommend follow-ups.
> 5. Documentation — update the incident, comment the alert, produce the investigation audit log.
>
> Route every user who consented to sensitive scopes (Mail._, Files._, User.Read.All) to the compromised-account playbook as a side-output."

---

## Demo talking points

- **Full loop inside the server** — contrast with the phishing playbook where purge lives outside. Here investigation → containment → hardening → documentation all chain through the MCP server, no handoff.
- **Token-economy literacy** — the playbook surfaces _why_ revoking sessions before killing the SP is the wrong order. The LLM explains the invariant; the tools enforce it.
- **Severity classification** — critical (app permissions) vs high (tenant-wide delegated) vs medium / low. Mechanical but routinely mishandled by human responders under pressure.
- **Preventive follow-up** — Phase 4 exposes the permission-grant policy as the root cause. Most incident playbooks stop at remediation; this one closes the prevention loop in the same conversation.

---

## Related playbooks

- [Compromised Account](compromised-account.md) — invoked per affected user.
- [Phishing Campaign (Tenant-Wide)](phishing-tenant-wide.md) — consent phishing often starts as a phishing email.

See [USE_CASES.md](../USE_CASES.md) for the broader catalogue of scenarios.
