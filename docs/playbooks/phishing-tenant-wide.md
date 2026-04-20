# Playbook — Phishing Campaign (Tenant-Wide)

Scoping, victim identification, and handoff-to-containment for a phishing campaign that reached multiple mailboxes. The MCP server is used as the **investigation plane** (visibility, correlation, documentation). Mailbox-content purge happens in Defender Threat Explorer or via a mailbox-scoped MCP — see the [scope boundary](#scope-boundary) below.

---

## Trigger signals

- A user reports a suspicious message (help desk ticket, Report Phishing button).
- A Defender / Identity Protection alert mentions a phishing indicator (sender, URL, IP).
- A [threat intel article](https://learn.microsoft.com/en-us/graph/api/resources/security-article) matches a pattern seen in the tenant.
- Unusual `list-message-traces` volume from a suspicious sender domain.

---

## Scope boundary

This admin-focused server does **not** expose per-message mailbox operations (no `delete-mail-message` across users, no `list-mail-rules` for arbitrary users). Those belong to a mailbox-scoped Graph app (`Mail.ReadWrite`, `MailboxSettings.ReadWrite` on every mailbox) or to Microsoft Defender Threat Explorer.

What this server **does** give you for phishing:

- Tenant-wide message-trace visibility — _who received what, when, from where_.
- Victim correlation — sign-ins, risk detections, directory audits post-delivery.
- Security incident / alert lifecycle — classification, comments, closure.
- Threat intel enrichment — IOC lookups, article cross-reference.

The playbook ends with a **handoff package** (list of affected UPNs, message IDs, IOCs) ready for the team or tool that will perform the purge.

---

## Prerequisites

### Presets

- **Scoping + correlation (read-only)**
  ```bash
  node dist/index.js --preset security,exchange,audit,identity
  ```
- **Documentation (writes on incidents/alerts only)**
  ```bash
  node dist/index.js --preset security --allow-writes
  ```

### Delegated permissions (minimum)

- `SecurityAlert.ReadWrite.All`, `SecurityIncident.ReadWrite.All`
- `ThreatIntelligence.Read.All`, `ThreatAssessment.Read.All`
- `Mail.ReadBasic.All` _(for message trace)_ or the Exchange Online `MessageTracking` role
- `AuditLog.Read.All`, `Directory.Read.All`
- `IdentityRiskEvent.Read.All`, `IdentityRiskyUser.Read.All`

See [APP_REGISTRATION.md](../APP_REGISTRATION.md).

---

## Phase 1 — Scope the campaign

Goal: turn a single signal into a list of delivered messages, sender infrastructure, and affected recipients.

| #   | Objective                               | MCP tool(s)                                                                | Notes                                                                                                                     |
| --- | --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Enumerate related alerts and incidents  | `list-security-alerts`, `list-security-incidents`, `get-security-incident` | Filter on `category = Phishing` or keywords from the reported message.                                                    |
| 2   | Pull user-submitted reports             | `list-threat-assessment-requests`                                          | Employees using the _Report Phishing_ button surface here.                                                                |
| 3   | Match against known campaigns           | `list-threat-intel-articles`, `list-threat-intel-article-indicators`       | Cross-reference sender domain, URL, IP against Microsoft threat intel articles.                                           |
| 4   | Measure delivery footprint              | `list-message-traces`                                                      | Filter by `senderAddress`, `subject`, `fromDateTime`, `toDateTime`. Extract recipient list, delivery status, message IDs. |
| 5   | Inspect a suspicious delivery in detail | `get-message-trace`                                                        | For each high-signal message ID, get the full trace (hops, spam verdict, policy hits).                                    |

### Sample prompt

> "Over the last 72 hours, list all inbound message traces where the sender domain is `contoso-billing.co` or the subject contains `invoice overdue`. Group by recipient and show delivery status. Cross-reference the sender IP against threat-intel articles and pull any related security alerts."

---

## Phase 2 — Identify victims who engaged

A recipient is not yet a victim. Engagement is inferred from sign-in activity, risk detections, and tenant operations **after** delivery.

For each recipient from Phase 1:

| #   | Objective                                | MCP tool(s)                                | Notes                                                                                                                                                              |
| --- | ---------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 6   | Baseline the user                        | `get-user`                                 | Confirm identity, department, privileged-role membership (privileged targets escalate severity).                                                                   |
| 7   | Detect post-delivery suspicious sign-ins | `list-sign-ins`                            | Window starts at message delivery time. Look for atypical location, anonymous IP, legacy auth, MFA-not-satisfied-but-granted.                                      |
| 8   | Correlate with Identity Protection       | `list-risk-detections`, `list-risky-users` | A detection timestamped just after delivery is a strong engagement signal.                                                                                         |
| 9   | Spot attacker actions post-click         | `list-directory-audits`                    | Filter `initiatedBy.user.id = <recipientId>` from delivery onward. New OAuth consents and mail rules (visible as audit entries) are the two highest-signal events. |

### Classification output

Classify each recipient into one of:

- **Unaffected** — no engagement signal.
- **Engaged** — clicked or authenticated from suspicious context, no compromise confirmed yet.
- **Confirmed compromised** — risk detection + post-delivery directory-audit activity or session from attacker infra.

Confirmed compromised recipients → trigger the [Compromised Account playbook](compromised-account.md) per user.

---

## Phase 3 — Handoff package for purge

The server cannot delete messages from every mailbox itself. Instead, produce a structured handoff the purge operator (Defender Threat Explorer, Exchange PowerShell, or mailbox-scoped MCP) can act on in one shot.

The handoff should include:

- **Message identity** — list of `internetMessageId` / `messageTraceId` values from Phase 1.
- **Sender IOCs** — addresses, domains, IPs, URLs.
- **Recipient list** — every UPN with delivery status `Delivered` or `Quarantined→Released`.
- **Time window** — earliest and latest delivery timestamp.
- **Confirmed compromised UPNs** — already routed to the compromised-account playbook.

### Sample prompt

> "From Phase 1 results, generate a markdown handoff package with: (a) deduplicated internetMessageId list, (b) sender IOC table (address, domain, sending IP, URL), (c) recipient table with delivery status and engagement classification, (d) first/last delivery timestamps. Format so it can be pasted into a Defender Threat Explorer bulk action."

---

## Phase 4 — Documentation and closure

| #   | Action                                   | MCP tool                     | Notes                                                                                              |
| --- | ---------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| 10  | Bind related alerts to a single incident | `update-security-incident`   | Classification `truePositivePhishing`, assignee, status `inProgress`.                              |
| 11  | Narrative on each alert                  | `add-security-alert-comment` | Timeline bullet points — detection, scope, victims, handoff sent.                                  |
| 12  | Audit trail of the investigation window  | `list-directory-audits`      | Capture every operation the responder performed through the server. Attach to the incident record. |

---

## Full-run demo prompt (single-shot)

> "A user just reported a phishing email from `no-reply@contoso-billing.co` with subject `Invoice overdue — action required`. Run the phishing playbook:
>
> 1. Scope — list all message traces of this campaign in the last 72 h, cross-reference sender IP with threat-intel articles, and list related security alerts/incidents.
> 2. Victims — for every recipient, pull their profile, sign-ins post-delivery, risk detections, and directory-audit operations. Classify them as unaffected, engaged, or confirmed compromised.
> 3. Handoff — produce a markdown handoff package (message IDs, IOCs, recipient table) ready for Defender Threat Explorer.
> 4. Documentation — update the related incident to `inProgress / truePositivePhishing`, add a timeline comment to each alert, and pull the investigation audit log.
>
> Confirm with me before the documentation writes. Flag privileged-role members among recipients immediately."

---

## Demo talking points

- **Cross-surface correlation** — message trace + sign-ins + risk detections + directory audits, all from one conversation. Painful to stitch together manually, trivial here.
- **Honest scope** — the playbook stops at the handoff instead of pretending to purge. Demonstrates an MCP server that knows its boundaries.
- **Severity triage** — flagging privileged-role recipients early is the kind of judgment call LLMs do well and shell scripts don't.
- **Meta-audit closure** — same pattern as the compromised-account playbook: the investigator's own actions end up in `list-directory-audits`.

---

## Related playbooks

- [Compromised Account](compromised-account.md) — triggered per confirmed victim.
- OAuth illicit consent — _draft_. Often a phishing lure leads to consent phishing instead of credential theft — that flow is covered separately.

See [USE_CASES.md](../USE_CASES.md) for the broader catalogue of scenarios.
