# usecase-exchange — Message traces and mailboxes

**When to load:** mail delivery investigation (blocked, malware, missing), mailbox audit, item export.

**Upstream references:** Exchange-adjacent topics appear throughout [USE_CASES.md](../../../docs/USE_CASES.md); the [phishing-tenant-wide playbook](../../../docs/playbooks/phishing-tenant-wide.md) is the canonical end-to-end procedure.

## Tools in scope

### Read

| Tool                            | Usage                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `list-message-traces`           | Message traces. Filters: `senderAddress`, `recipientAddress`, `startDate`, `endDate`, `status`, `messageId`. |
| `get-message-trace`             | Trace detail.                                                                                                |
| `list-exchange-mailboxes`       | Mailbox list.                                                                                                |
| `get-exchange-mailbox`          | Mailbox detail.                                                                                              |
| `list-exchange-mailbox-folders` | Folders.                                                                                                     |
| `get-exchange-mailbox-folder`   | Folder detail.                                                                                               |

### Write

| Tool                            | Risk                                  |
| ------------------------------- | ------------------------------------- |
| `export-exchange-mailbox-items` | medium                                |
| `update-exchange-mailbox`       | medium                                |
| `delete-exchange-mailbox`       | **critical** — out-of-band escalation |

## Pattern 1 — Undelivered mail investigation

> _"`partner@example.com`'s email didn't reach `jdoe@contoso.com`."_

1. `list-message-traces` with `$filter=senderAddress eq 'partner@example.com' and recipientAddress eq 'jdoe@contoso.com' and startDate ge <yesterday>`.
2. Identify `status`:
   - `Delivered` — but user says not received: check Junk, inbox rules (use a delegated server or PowerShell `Get-InboxRule` since list-mail-rules over a third party's mailbox isn't exposed by this server).
   - `FilteredAsSpam` / `Quarantined` — filtered.
   - `Failed` — bounce, check reason.
   - `Pending` / `GettingStatus` — in flight, retry.
3. For non-trivial statuses, `get-message-trace` for the detail.

## Pattern 2 — Suspicious mailbox audit

> _"User reports emails are marked read without their intervention."_

1. `get-exchange-mailbox` for the user.
2. `list-exchange-mailbox-folders` → check for hidden / unexpected folders.
3. **Hidden inbox rules** (attacker technique): not currently exposed by this server for third-party mailboxes. Workaround: PowerShell `Get-InboxRule -Mailbox <user>` or direct Graph with `MailboxSettings.Read`.
4. If suspicious patterns (forwarding rules, delete rules), treat as compromise → `usecase-response.md`.

## Pattern 3 — Light-weight item export

> _"Export emails from `jdoe@contoso.com` matching keyword `project-atlas` from Q3."_

⚠ For a **formal legal request**, use **Purview eDiscovery** (`usecase-ediscovery.md`), NOT this tool. `export-exchange-mailbox-items` is for lightweight admin needs (recover a lost email, employee offboarding).

1. Confirm scope with the requester.
2. Validate with your privacy officer if the export touches personal data in a regulated jurisdiction.
3. `export-exchange-mailbox-items` (medium) → explicit confirmation.
4. Document in your tracker.

## Guardrails

- **`delete-exchange-mailbox` (critical)** — out-of-band escalation. Data destruction. Prefer hold + standard offboarding.
- **`export-exchange-mailbox-items`** — verify legal basis (user consent, formal HR request, or eDiscovery hold). Never export without documentation.
- **`update-exchange-mailbox`** — verify you're not modifying quota or litigation hold unintentionally.

## Crosswalk

- Compromised account → `usecase-response.md`.
- Formal legal search → `usecase-ediscovery.md`.
- Account identity → `usecase-identity.md`.
- Tenant-wide phishing campaign → [`docs/playbooks/phishing-tenant-wide.md`](../../../docs/playbooks/phishing-tenant-wide.md).
