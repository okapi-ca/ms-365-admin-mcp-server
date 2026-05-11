# usecase-infoprotection — BitLocker, sensitivity labels, threat assessment

**When to load:** BitLocker key recovery, sensitivity label audit, Exchange threat assessment.

## Tools in scope

### BitLocker

| Tool                           | Usage                    |
| ------------------------------ | ------------------------ |
| `list-bitlocker-recovery-keys` | BitLocker recovery keys. |

⚠ **Highly sensitive.** Access to BitLocker keys enables disk decryption. Use only with legitimate basis (user-driven recovery after lockout, formal forensic investigation).

### Threat assessment

| Tool                              | Usage                                                                    |
| --------------------------------- | ------------------------------------------------------------------------ |
| `list-threat-assessment-requests` | Threat assessment requests (URLs, files, emails) submitted to Microsoft. |

### Sensitivity labels

| Tool                                               | Usage                       |
| -------------------------------------------------- | --------------------------- |
| `list-sensitivity-labels`, `get-sensitivity-label` | Published labels.           |
| `list-sensitivity-sublabels`                       | Sub-labels.                 |
| `get-sensitivity-label-rights`                     | Rights attached to a label. |
| `get-protection-scopes`                            | Protection scopes.          |

## Pattern 1 — BitLocker key recovery

> _"User `jdoe@contoso.com` can't unlock their laptop — BitLocker screen."_

### Step 1 — Validation

- [ ] Confirm requester's identity through a verified channel (not just email).
- [ ] Confirm it's the user's device (cross-reference `list-managed-devices` or `list-devices`).
- [ ] Document the helpdesk ticket with the reason.

### Step 2 — Retrieval

```
list-bitlocker-recovery-keys($filter="deviceId eq '<device-id>'")
```

Retrieve the key and transmit via a secure channel (do not email in plain text).

### Step 3 — Documentation

In the helpdesk ticket:

- Device involved.
- Date/time of communication.
- Channel used.

⚠ **Do not log the key value itself** in the ticket.

## Pattern 2 — Sensitivity label audit

> _"What labels are published and what protection do they apply?"_

1. `list-sensitivity-labels` → all labels.
2. For each, `get-sensitivity-label` + `get-sensitivity-label-rights` → encryption, watermarking, content marking, conditions.
3. `list-sensitivity-sublabels` → sub-labels.
4. Present: Label | Encryption (Y/N + permissions) | Marking | Sub-labels | Scope.

## Pattern 3 — Threat assessment audit

> _"What threat assessments were submitted this month?"_

1. `list-threat-assessment-requests` filtered on the window.
2. Present by type (URL, file, email).
3. Identify recurring submitter patterns.

## Guardrails

- **`list-bitlocker-recovery-keys`** — audit-logged. Every call is traced. Never use outside a validated ticket.
- **Sensitivity labels** — no write tools exposed here. Modify via the Purview compliance portal.

## Crosswalk

- Device context → `usecase-intune.md`.
- Forensic investigation → `usecase-ediscovery.md`.
