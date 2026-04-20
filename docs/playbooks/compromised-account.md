# Playbook — Compromised Account

End-to-end incident response scenario driven through `ms-365-admin-mcp-server`. From the first risk signal to the post-incident audit report, every step maps to a concrete MCP tool.

This is the flagship demo scenario: it chains 11+ tools across identity, audit, and response categories and exercises the read-only → `--allow-writes` progression.

---

## Trigger signals

Any of the following typically opens this playbook:

- A user appears in `list-risky-users` with `riskLevel = high`.
- A security alert or incident (Microsoft 365 Defender / Identity Protection) targets a user identity.
- A sign-in flagged _impossible travel_, _atypical location_, or _anonymous IP_.
- A user self-reports a phishing click or a stolen credential.

---

## Prerequisites

### Presets

- **Investigation (Phase 1)** — read-only.
  ```bash
  node dist/index.js --preset identity,audit,security
  ```
- **Containment (Phase 2)** — writes enabled.
  ```bash
  node dist/index.js --preset identity,audit,security,response --allow-writes
  ```

### Delegated permissions

The Entra ID application registration used by the MCP server must hold (at minimum):

- `User.Read.All`, `AuditLog.Read.All`, `Directory.Read.All`
- `IdentityRiskEvent.Read.All`, `IdentityRiskyUser.ReadWrite.All`
- `UserAuthenticationMethod.ReadWrite.All`
- `User.EnableDisableAccount.All`, `User.RevokeSessions.All`
- `SecurityAlert.ReadWrite.All`, `SecurityIncident.ReadWrite.All`

See [APP_REGISTRATION.md](../APP_REGISTRATION.md) for the full list and consent procedure.

### Guardrail — break-glass exclusion

Never run the containment phase against a break-glass account. Confirm the target `userPrincipalName` is **not** in the tenant's emergency-access list before any write.

---

## Phase 1 — Investigation (read-only)

Goal: confirm the compromise, reconstruct the attacker's timeline, and measure the blast radius.

| #   | Objective                                        | MCP tool(s)                                       | Notes                                                                                                                                                                  |
| --- | ------------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Confirm the subject and baseline context         | `get-user`, `get-risky-user`                      | Display name, UPN, job title, last interactive sign-in, current risk state.                                                                                            |
| 2   | Reconstruct the sign-in timeline                 | `list-sign-ins`                                   | Filter on `userId` and the last 24–72 h. Extract IP, location, client app, conditional access result, risk level per sign-in.                                          |
| 3   | Correlate with Identity Protection detections    | `list-risk-detections`, `list-risky-user-history` | Maps detections (e.g. _malwareInfectedIPAddress_, _unfamiliarFeatures_) to sign-ins from step 2.                                                                       |
| 4   | Measure blast radius — what did the attacker do? | `list-directory-audits`                           | Filter `initiatedBy.user.id = <userId>`. Look for new OAuth consents, new role assignments, password resets, mail rules, group memberships, application registrations. |
| 5   | Detect MFA persistence added by the attacker     | `list-user-auth-methods`                          | A phone or authenticator app registered during the compromise window is a classic persistence mechanism.                                                               |

### Sample investigation prompt

> "User `jdoe@contoso.com` was just flagged as risky high. Pull their profile, list every sign-in from the last 48 hours with IP, location, client, and risk level, correlate with Identity Protection risk detections, and list every directory-audit operation they initiated in the same window. Flag any MFA method registered in the last 7 days."

---

## Phase 2 — Containment (writes)

Goal: kill active access, remove attacker persistence, and feed the Identity Protection model.

> Always run every write in dry-run first: have the LLM list the target entity and the exact operation, wait for operator confirmation, then execute.

| #   | Action                                      | MCP tool                        | Risk         | Effect                                                                                                           |
| --- | ------------------------------------------- | ------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| 6   | Revoke all active sessions (refresh tokens) | `revoke-user-sessions`          | **high**     | Forces re-authentication on every client within minutes.                                                         |
| 7   | Disable the account if severity warrants it | `disable-user-account`          | **critical** | Blocks all sign-ins. Use when the user can be reached through an alternate channel.                              |
| 8   | Remove attacker-added phone MFA             | `delete-user-phone-auth-method` | **high**     | Removes the rogue phone. Repeat with other `delete-user-*-auth-method` tools if authenticator or FIDO was added. |
| 9   | Confirm compromised in Identity Protection  | `confirm-compromised-users`     | **high**     | Marks `riskState = confirmedCompromised`. Feeds the ML model and triggers dependent Conditional Access policies. |

### Sample containment prompt

> "Containment phase for `jdoe@contoso.com`. Before each write, show me the target and wait for my confirmation. Steps: (1) revoke all sessions, (2) disable the account, (3) delete any phone auth method registered after 2026-04-15, (4) mark the user as confirmed compromised in Identity Protection."

---

## Phase 3 — Documentation and audit

Goal: record the response on the incident/alert, and produce a traceability report proving every action taken.

| #   | Action                                  | MCP tool                     | Notes                                                                                                                                          |
| --- | --------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | Update the security incident            | `update-security-incident`   | Status (e.g. `active` → `inProgress`), classification, assignee.                                                                               |
| 11  | Leave a narrative trail on the alert    | `add-security-alert-comment` | Short chronology referencing the audit window.                                                                                                 |
| 12  | Generate the post-incident audit report | `list-directory-audits`      | Filter on the operator service principal / delegated user, over the response window. Every write from Phase 2 appears there — the loop closes. |

### Sample documentation prompt

> "Update incident `<id>` with status `inProgress`, classification `truePositive / compromisedAccount`, and assign it to me. Add a comment to the related alert summarizing the timeline (first malicious sign-in, containment actions, MFA cleanup). Finally, pull every directory-audit entry written during the containment window and produce a markdown table."

---

## Full-run demo prompt (single-shot)

Use this when demoing the end-to-end flow in one shot. The LLM will chain all three phases, pausing for confirmation before each write.

> "User `jdoe@contoso.com` was just flagged as risky high. Run the compromised-account playbook:
>
> 1. Investigation — profile, sign-in timeline over 48 h, correlated risk detections, directory-audit operations they initiated, and any auth method registered in the last 7 days.
> 2. Containment — wait for my explicit confirmation before each write: revoke sessions, disable the account, delete attacker-added MFA, mark as confirmed compromised.
> 3. Documentation — update the related security incident, comment the alert, and pull the final audit report covering my containment window.
>
> Use the least-privilege preset and stop immediately if the target matches a break-glass naming pattern."

---

## Demo talking points

- **Breadth** — 11 distinct Graph endpoints orchestrated in one conversation, across 4 tool categories (`identity`, `audit`, `security`, `response`).
- **Safety rails** — read-only by default, `--allow-writes` required for Phase 2, and every `high`/`critical` tool runs dry-run-then-confirm.
- **Closed loop** — the final `list-directory-audits` call (step 12) surfaces the exact operations the analyst just executed, which is both an audit artefact and a meta-validation of the MCP server itself.
- **LLM value-add** — natural-language correlation between sign-ins, risk detections, and directory audits is the part that is painful with raw Graph calls and becomes trivial here.

---

## Related playbooks

- Phishing campaign (tenant-wide) — _draft_
- OAuth illicit consent — _draft_

See [USE_CASES.md](../USE_CASES.md) for the broader catalogue of scenarios.
