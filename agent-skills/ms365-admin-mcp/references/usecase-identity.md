# usecase-identity — Users, groups, PIM, applications, guests

**When to load:** identity management, PIM hygiene, application credential audit, B2B/guest governance, license assignment.

**Upstream references:** [USE_CASES.md §4 Privileged identity hygiene](../../../docs/USE_CASES.md), [§5 Application and credential audit](../../../docs/USE_CASES.md), [§6 Guest user governance](../../../docs/USE_CASES.md).

This is the largest domain — refer to the appropriate subsection below.

## Section A — Users

### Read

| Tool                     | Usage                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `list-users`             | Account list. Filters: `userType eq 'Guest'`, `accountEnabled eq false`, license-based. |
| `get-user`               | Account detail.                                                                         |
| `list-user-memberships`  | Groups and roles for a user.                                                            |
| `list-user-auth-methods` | Configured MFA methods.                                                                 |
| `list-user-devices`      | Entra-registered devices.                                                               |

### Write

| Tool                     | Risk         | When                                                          |
| ------------------------ | ------------ | ------------------------------------------------------------- |
| `create-user`            | high         | Manual provisioning — prefer Entra Connect / HR-driven flows. |
| `update-user`            | medium       | Attribute updates (jobTitle, manager, department).            |
| `delete-user`            | **critical** | Out-of-band escalation required.                              |
| `assign-user-license`    | medium       | SKU assignment.                                               |
| `reprocess-user-license` | low          | Re-process after group-based licensing change.                |
| `change-user-password`   | high         | Admin reset — prefer self-service password reset.             |

## Section B — Groups

### Read

| Tool                 | Usage                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `list-groups`        | Group list. Filter by `securityEnabled`, `mailEnabled`, `groupTypes` (e.g. `'Unified'` for M365). |
| `get-group`          | Group detail.                                                                                     |
| `list-group-members` | Direct members.                                                                                   |
| `list-group-owners`  | Owners.                                                                                           |

### Write

| Tool               | Risk         | When                                                                         |
| ------------------ | ------------ | ---------------------------------------------------------------------------- |
| `create-group`     | medium       | Security or M365 group creation.                                             |
| `update-group`     | medium       | Attribute updates.                                                           |
| `delete-group`     | **critical** | Out-of-band escalation — cascades to license assignment, CA scoping, access. |
| `add-group-member` | medium       | Care with groups used in CA, license assignment, or security boundaries.     |

## Section C — Roles and PIM

### Read

| Tool                                 | Usage                          |
| ------------------------------------ | ------------------------------ |
| `list-directory-roles`               | Roles activated on the tenant. |
| `list-role-members`                  | Permanent members of a role.   |
| `list-role-assignments`              | Unified assignments.           |
| `list-role-definitions`              | All role definitions.          |
| `list-pim-eligible-assignments`      | Eligible (not yet activated).  |
| `list-pim-active-assignments`        | Currently elevated.            |
| `list-pim-role-assignment-schedules` | Activation schedules.          |
| `list-pim-role-assignment-requests`  | Activation history.            |

### Write (PIM activation)

| Tool                                  | Risk                             | When                                                                                                                         |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `add-directory-role-member`           | **critical**                     | Direct elevation (bypasses PIM) — out-of-band escalation required.                                                           |
| `create-pim-role-assignment-request`  | **critical** on privileged roles | PIM activation: legitimate for non-privileged roles; for Global Admin / Privileged Role Admin / Security Admin → escalation. |
| `cancel-pim-role-assignment-request`  | high                             | Cancel an activation.                                                                                                        |
| `create-pim-role-eligibility-request` | **critical**                     | Make someone eligible — out-of-band escalation required.                                                                     |

## Section D — Applications, service principals, credentials

### Read

| Tool                             | Usage                                             |
| -------------------------------- | ------------------------------------------------- |
| `list-applications`              | App registrations.                                |
| `get-application`                | Detail incl. passwordCredentials, keyCredentials. |
| `list-application-owners`        | Owners.                                           |
| `list-app-federated-credentials` | Workload identity federation credentials.         |
| `get-app-federated-credential`   | Single FIC.                                       |
| `list-service-principals`        | SPs (consented apps).                             |
| `get-service-principal`          | SP detail.                                        |
| `list-service-principal-owners`  | SP owners.                                        |
| `list-oauth2-grants`             | Delegated consents.                               |
| `list-sp-app-role-assignments`   | App roles assigned to the SP.                     |
| `list-sp-delegated-permissions`  | SP delegated permissions.                         |
| `list-user-app-role-assignments` | App roles assigned to a user.                     |
| `list-app-management-policies`   | App credential management policies.               |

### Write (all `high` or `critical`)

| Tool                                                                                                                                                                           | Risk         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `create-application`, `update-application`                                                                                                                                     | high         |
| `delete-application`                                                                                                                                                           | **critical** |
| `add-application-password`, `remove-application-password`, `add-application-key`, `remove-application-key`                                                                     | high         |
| `add-application-owner`, `remove-application-owner`                                                                                                                            | high         |
| `create-app-federated-credential`, `update-app-federated-credential`, `delete-app-federated-credential`                                                                        | high         |
| `create-service-principal`                                                                                                                                                     | high         |
| `delete-service-principal`                                                                                                                                                     | **critical** |
| `add-sp-password`, `remove-sp-password`, `add-sp-key`, `remove-sp-key`, `add-sp-token-signing-certificate`, `add-sp-owner`, `remove-sp-owner`, `create-sp-app-role-assignment` | high         |
| `set-application-verified-publisher`                                                                                                                                           | medium       |

## Section E — Guests, B2B

| Tool                                                                                                               | Risk   |
| ------------------------------------------------------------------------------------------------------------------ | ------ |
| `list-invitations`, `list-identity-providers`, `get-identity-provider`, `list-b2x-user-flows`, `get-b2x-user-flow` | read   |
| `list-api-connectors`, `get-api-connector`, `list-custom-auth-extensions`                                          | read   |
| `create-invitation`                                                                                                | medium |

## Section F — Entra devices

| Tool           | Usage                     |
| -------------- | ------------------------- |
| `list-devices` | Entra-registered devices. |
| `get-device`   | Device detail.            |

(For Intune managed devices, see `usecase-intune.md`.)

## Section G — Administrative units

| Tool                                                                                         | Risk   |
| -------------------------------------------------------------------------------------------- | ------ |
| `list-administrative-units`, `get-administrative-unit`, `list-administrative-unit-members`   | read   |
| `create-administrative-unit`, `update-administrative-unit`, `add-administrative-unit-member` | medium |
| `delete-administrative-unit`                                                                 | high   |

## Section H — Organization, domains

| Tool                               | Risk   |
| ---------------------------------- | ------ |
| `get-organization`, `list-domains` | read   |
| `create-domain`                    | high   |
| `verify-domain`                    | medium |

## Pattern 1 — Quarterly PIM hygiene

> _"Audit privileged roles on the tenant."_

1. `list-directory-roles` → identify activated roles.
2. For each privileged role (Global Admin, Privileged Role Admin, Security Admin, Exchange Admin, SharePoint Admin, Application Admin, User Access Admin, Conditional Access Admin):
   - `list-role-members` (permanent)
   - `list-pim-eligible-assignments` filtered by `roleDefinitionId`
3. For each member:
   - `get-user` → check `accountEnabled`, `lastSignInDateTime`
   - `list-user-auth-methods` → confirm strong MFA
   - `list-sign-ins` filtered → recent activity
4. Present a table: Role | User | Type (permanent / eligible) | MFA | Last sign-in | Justification.
5. Flag: permanents instead of eligibles, weak MFA, dormant 30d+.

## Pattern 2 — Audit applications and expiring credentials

> _"Which app registrations have secrets expiring in 60 days?"_

1. `list-applications` with `$top=200` (paginate if needed).
2. For each app, examine `passwordCredentials[].endDateTime` and `keyCredentials[].endDateTime`.
3. Filter expirations < `now + 60d`.
4. For each candidate: `list-application-owners` → identify owner to contact.
5. Present: App | Cred type | Expiration | Owner | Graph permissions (severity).
6. Flag **orphaned** apps (no owner) and apps with **privileged permissions** (`Directory.ReadWrite.All`, `Application.ReadWrite.All`, etc.).

## Pattern 3 — Guest governance

> _"List guests inactive for 90 days."_

1. `list-users` with `$filter=userType eq 'Guest'` and `$top=200`.
2. For each guest, cross-reference with `list-sign-ins` filtered by UPN.
3. Identify those without sign-in > 90d.
4. Group by invitation domain (`mail` or parsed UPN).
5. Propose a cleanup plan: sponsor review before disable/delete.

## Guardrails

- **`delete-user`, `delete-group`, `delete-application`, `delete-service-principal`** — all critical, out-of-band escalation required.
- **Modifying ownership of groups** used in CA scoping or license assignment has cascading impact — always document before.
- **Privileged app registrations**: never add a secret without a rotation plan. Document in your secrets management system.
- **B2B invitations**: verify the sponsor is identified and the partner domain is allowed by your cross-tenant access policy.

## Crosswalk

- Compromised user → `usecase-response.md`.
- A user's devices → `usecase-intune.md` (managed) or this file (Entra-registered).
- Conditional Access affecting a group → `usecase-compliance.md`.
- Access reviews on groups / apps → `usecase-governance.md`.
