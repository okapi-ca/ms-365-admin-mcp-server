# usecase-compliance — Licenses, Secure Score, Identity Protection, Conditional Access

**When to load:** security posture review, scoring trends, risk detection triage, Conditional Access audit / deployment, auth methods policy, tenant licenses.

**Upstream references:** [USE_CASES.md §15 Conditional Access — audit and deployment](../../../docs/USE_CASES.md), [§1 Daily security monitoring](../../../docs/USE_CASES.md) (Secure Score).

## Section A — Secure Score

| Tool                         | Usage                         |
| ---------------------------- | ----------------------------- |
| `list-secure-scores`         | Score history.                |
| `get-secure-score`           | Score detail at a given date. |
| `list-secure-score-controls` | Recommendations (controls).   |
| `get-secure-score-control`   | Control detail.               |

All read-only. Use for:

- Trends over 30 / 60 / 90 days.
- Top non-implemented controls (impact / effort).
- Comparison vs. peer benchmark provided by Microsoft.

## Section B — Identity Protection / risky users

### Read

| Tool                                                           | Usage                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `list-risky-users`                                             | Currently-risky users. Filters: `riskLevel` (low/medium/high), `riskState`. |
| `get-risky-user`                                               | Detail incl. risky activities.                                              |
| `list-risky-user-history`                                      | History for a user.                                                         |
| `list-risky-service-principals`, `get-risky-service-principal` | Risky SPs.                                                                  |
| `list-service-principal-risk-detections`                       | SP risk detections.                                                         |
| `list-risk-detections`                                         | All detections (users + SPs).                                               |
| `get-risk-detection`                                           | Detection detail.                                                           |

### Write

All writes are `high` and routed through `usecase-response.md` (`confirm-compromised-users`, `confirm-safe-users`, `dismiss-risky-users`, and SP equivalents).

## Section C — Licenses (subscribed SKUs)

| Tool                   | Usage                          |
| ---------------------- | ------------------------------ |
| `list-subscribed-skus` | SKUs subscribed by the tenant. |
| `get-subscribed-sku`   | SKU detail (units, services).  |

Combine with `list-users` for assignment analysis (see Pattern 3 below).

## Section D — Conditional Access

### Read

| Tool                                  | Usage                             |
| ------------------------------------- | --------------------------------- |
| `list-conditional-access-policies`    | All CA policies.                  |
| `get-conditional-access-policy`       | Policy detail.                    |
| `list-named-locations`                | Named locations (IPs, countries). |
| `list-conditional-access-templates`   | Available templates.              |
| `list-conditional-access-policies-v2` | v2 endpoint.                      |

### Write

| Tool                               | Risk         |
| ---------------------------------- | ------------ |
| `create-conditional-access-policy` | high         |
| `update-conditional-access-policy` | high         |
| `delete-conditional-access-policy` | **critical** |
| `create-named-location`            | medium       |
| `update-named-location`            | medium       |
| `delete-named-location`            | high         |

## Section E — Authentication policies

| Tool                                                                                              | Usage                                           |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `get-auth-methods-policy`                                                                         | Global auth methods policy.                     |
| `list-auth-method-configs`, `get-auth-method-config`                                              | Per-method configs (FIDO2, MS Auth, SMS, etc.). |
| `get-security-defaults`                                                                           | Security defaults status.                       |
| `get-admin-consent-policy`                                                                        | Admin consent workflow.                         |
| `list-auth-strength-policies`, `get-auth-strength-policy`                                         | Auth strength policies.                         |
| `create-auth-strength-policy`, `update-auth-strength-policy`, `delete-auth-strength-policy`       | high / high / high                              |
| `get-cross-tenant-access-policy`, `list-cross-tenant-partners`, `get-cross-tenant-default-policy` | read                                            |

## Section F — Identity governance policies (read-only references)

`list-activity-timeout-policies`, `get-authorization-policy`, `get-auth-flows-policy`, `list-claims-mapping-policies`, `get-default-app-management-policy`, `get-device-registration-policy`, `list-feature-rollout-policies`, `list-home-realm-discovery-policies`, `list-permission-grant-policies`, `list-role-management-policies`, `list-role-management-policy-assignments`, `list-token-issuance-policies`, `list-token-lifetime-policies`.

## Pattern 1 — Conditional Access audit

> _"Full audit of CA policies."_

1. `list-conditional-access-policies` → all policies.
2. For each, present: Name | State (`enabled` / `disabled` / `enabledForReportingButNotEnforced`) | Users (include/exclude) | Apps | Conditions | Grant controls | Session controls.
3. `list-named-locations` → join names.
4. **Findings to flag:**
   - Policies in `report-only` for > 30d (enforce or remove).
   - Policies without break-glass exclusion.
   - Critical apps (M365, Azure, admin portals) without MFA requirement.
   - Disabled orphan policies.
5. Cross-reference with `list-applications` to identify apps not covered by any MFA-requiring CA.

## Pattern 2 — Deploying a new CA policy

> _"Create a CA to block legacy auth."_

1. **Prepare the policy** in JSON. Verify:
   - `state: enabledForReportingButNotEnforced` (never `enabled` directly).
   - `excludeUsers`: break-glass account ID(s).
   - `excludeGroups`: any defined exception groups.
2. Dry-run: present the full JSON to the operator.
3. `create-conditional-access-policy` (high) → explicit confirmation.
4. Document in your change tracker.
5. Monitor for at least 7 days in report-only.
6. Before promoting to `enabled`, review impact via `list-sign-ins` filtered on `conditionalAccessStatus eq 'failure'` for the policy.
7. `update-conditional-access-policy` (high) to set `enabled` → explicit confirmation.

## Pattern 3 — License optimization

> _"Find E5 users inactive for 30 days."_

1. `list-subscribed-skus` → identify the E5 SKU.
2. `list-users` with `$filter=assignedLicenses/any(l:l/skuId eq <E5-id>)` → E5 holders.
3. Cross-reference with `list-sign-ins` or `get-active-users-report` (see `usecase-reports.md`) for activity.
4. Present: User | Department | Manager | Last activity | License assigned.
5. Recovery plan: manager review → reassign to a lower SKU or recover.

## Pattern 4 — Risky user triage

> _"Untriaged risky users."_

1. `list-risky-users` with `$filter=riskState eq 'atRisk'` (= never handled).
2. For each `riskLevel eq 'high'`:
   - `get-risky-user` → detail.
   - `list-risky-user-history` → patterns.
   - `list-risk-detections` filtered on UPN → source detections.
   - `list-sign-ins` filtered → context.
3. Decide per user:
   - **Compromised** → `usecase-response.md` (`confirm-compromised-users`).
   - **False positive** → `confirm-safe-users` (high).
   - **Indeterminate** → request more info from user / manager before deciding.

All writes are `high` → confirm per case.

## Guardrails

- **`delete-conditional-access-policy` (critical)**: out-of-band escalation required. A mis-deleted CA can grant or revoke access en masse.
- **`update-conditional-access-policy` that flips `state` from `report-only` to `enabled`** is functionally equivalent to deploying a new enforcement — explicit confirmation and a monitoring window.
- **`create-auth-strength-policy` / `update-` / `delete-`** affects every CA that references it. Always check dependencies first.
- **`auth-methods-policy` changes**: not covered by write tools here other than auth-strength. Modify via the Entra portal with formal change management.

## Crosswalk

- Risky user → containment → `usecase-response.md`.
- Suspicious sign-ins → `usecase-audit.md`.
- Apps in scope of CAs → `usecase-identity.md`.
- Usage reports for license analysis → `usecase-reports.md`.
