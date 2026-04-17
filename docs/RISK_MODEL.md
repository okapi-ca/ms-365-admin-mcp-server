# Risk Model

Every write tool in `ms-365-admin-mcp-server` is labeled with a risk level. This document explains the classification, how it's surfaced, and how to use it.

## Why risk levels

LLMs operating admin tools can cause real damage: delete users, wipe devices, disable policies, drop retention holds. Explicit risk classification:

- **Informs the LLM** — the risk level is appended to the tool description and visible to the model when it decides whether to call the tool.
- **Gives operators a policy surface** — a wrapper can require human confirmation for `critical` or `high`, or block them entirely.
- **Makes permission granting deliberate** — the risk level encourages granular consent rather than blanket `ReadWrite.All`.

## Classification rubric

| Level      | Reversibility                                          | Scope                             | Example tools                                                                  |
| ---------- | ------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------ |
| `low`      | Fully reversible or read-only-by-intent                | Narrow (one entity or a query)    | `run-hunting-query`, `add-security-alert-comment`, `sync-managed-device`       |
| `medium`   | Reversible with manual effort                          | Single entity                     | `update-user`, `add-group-member`, `create-invitation`, `remote-lock-device`    |
| `high`     | Partly reversible; significant operational impact      | Single entity with broad effect, or policy change | `revoke-user-sessions`, `update-conditional-access-policy`, `retire-managed-device`, `confirm-compromised-users` |
| `critical` | Irreversible without backups, or tenant-wide impact    | Tenant, multiple entities, data loss | `delete-user`, `wipe-managed-device`, `delete-conditional-access-policy`, `clean-windows-device`, `disable-user-account` |

### Decision questions

For a write tool, ask in order:

1. **Can the change be undone without data loss or administrator intervention?**
   - No, never → **critical**
   - Yes, but only with notable effort (re-enable account, re-invite user, restore from recycle bin within 30 days) → **high**
   - Yes, trivially (toggle a flag back) → **medium** or **low**

2. **What's the blast radius?**
   - Whole tenant or cross-tenant → elevate one level
   - Single user or device → baseline
   - Dry-run-only (POST that returns data without changing state) → **low**

3. **Can it be used for privilege escalation or data exfiltration?**
   - Yes → at least **high** regardless of other factors (e.g., `add-application-password`, `create-pim-role-assignment-request`)

When in doubt, pick the higher level. It's easy to downgrade later if real-world use shows the caution was excessive; it's much harder to recover from an undervalued `critical`.

## Examples

### Why `wipe-managed-device` is `critical`

Issuing a wipe:

- Destroys user data on the device (reversibility: none without backups)
- Cannot be recalled after execution (some seconds later, the device begins erasing)
- Often fires without further user interaction

Mitigation: the LLM description explicitly says "irreversible or has major security impact. Always confirm with the operator before executing."

### Why `disable-user-account` is `critical`

Although reversible (toggle `accountEnabled` back), disabling a user:

- Cuts them off from every service (email, Teams, files) immediately
- Can lock out a privileged admin in an emergency if the wrong account is picked
- Is the first move in a compromise response where acting on the wrong user delays real containment

### Why `revoke-user-sessions` is `high` (not `critical`)

It terminates active tokens but does not change credentials. The user can sign in again immediately; no data is lost. It's a significant operational event (users are logged out everywhere) but fully recoverable.

### Why `update-conditional-access-policy` is `high`

CA changes can lock out the entire tenant. The mitigation is procedural (deploy in report-only, test, then enforce), not technical — hence the level reflects what *can* happen, not what *usually* happens.

### Why `run-hunting-query` is `low`

The endpoint uses POST (KQL in the body) but does not mutate tenant state. It's a read-with-payload. Classifying it as `high` just because of the HTTP verb would be misleading.

### Why Intune report tools are `low`

Intune's reporting APIs (e.g., `intune-device-noncompliance-report`) require POST because the query body can be large. They produce a report; they don't change anything.

## Surface

### In the tool description (runtime)

`graph-tools.ts` appends `RISK LEVEL: <LEVEL>. <guidance>` to every non-GET tool:

```
RISK LEVEL: CRITICAL. This action is irreversible or has major security impact.
Always confirm with the operator before executing.

RISK LEVEL: HIGH. This action has significant impact. Verify the target carefully
before executing.
```

`medium` and `low` receive the level without extra guidance text.

### In `endpoints.json`

```jsonc
{
  "toolName": "delete-user",
  "pathPattern": "/users/{userId}",
  "method": "DELETE",
  "appPermissions": ["User.ReadWrite.All"],
  "riskLevel": "critical"
}
```

### In `--list-tools` output

```json
{
  "name": "delete-user",
  "method": "DELETE",
  "path": "/users/{userId}",
  "permissions": ["User.ReadWrite.All"]
}
```

Risk level is not currently emitted by `--list-tools`; grep `endpoints.json` if you need it offline.

## Operator playbook

For a production or shared deployment, wrap the server behind a policy layer that enforces:

1. **Critical operations require explicit out-of-band confirmation** — a Slack DM, a ticket approval, a second human. Not just LLM reasoning.
2. **High operations require an audit trail entry** — who asked, why, what was the target.
3. **All writes should produce a post-action verification** — e.g., after `disable-user-account`, query the user and confirm `accountEnabled == false`.
4. **Dry-run by default for bulk operations** — before looping `disable-user-account` over 50 users, list them first and confirm.

Template prompt pattern to encode in the system message:

```
Before any tool with riskLevel `high` or `critical`:

1. Describe the exact action and its target.
2. Describe the expected effect (who / what is affected).
3. Describe how to reverse it, if possible.
4. Ask the operator for explicit confirmation ("type `confirm` to proceed").
5. Only then invoke the tool.

After execution, query the affected entity and confirm the expected state change.
```

## Review

Risk classifications are reviewed:

- When a new write tool is added (during PR review)
- When an incident reveals a misclassification (see CHANGELOG #22, #28)
- As part of periodic security review

Challenges and proposals are welcome as GitHub issues tagged `risk-classification`.

## Glossary

- **Reversibility.** The effort needed to undo the action without data loss.
- **Blast radius.** How much of the tenant an action affects (one entity, one tenant, cross-tenant).
- **Scope.** Same as blast radius in practice.
- **Out-of-band confirmation.** Approval from a channel other than the LLM conversation itself.
