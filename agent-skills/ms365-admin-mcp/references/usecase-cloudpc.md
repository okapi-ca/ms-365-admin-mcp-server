# usecase-cloudpc — Cloud PC / Windows 365

**When to load:** Cloud PC provisioning, image management, CPC audit, Windows 365 governance.

## Tools in scope

### Read

| Tool                                    | Usage                              |
| --------------------------------------- | ---------------------------------- |
| `list-cloud-pcs`                        | Provisioned Cloud PCs.             |
| `list-cloud-pc-provisioning-policies`   | Provisioning policies.             |
| `list-cloud-pc-device-images`           | Custom images.                     |
| `list-cloud-pc-gallery-images`          | Microsoft-provided gallery images. |
| `list-cloud-pc-on-premises-connections` | On-prem network connections.       |
| `list-cloud-pc-user-settings`           | User-settings policies.            |
| `list-cloud-pc-audit-events`            | Cloud PC audit events.             |

### Write

| Tool                                  | Risk   |
| ------------------------------------- | ------ |
| `create-cloud-pc-provisioning-policy` | medium |
| `update-cloud-pc-provisioning-policy` | medium |
| `delete-cloud-pc-provisioning-policy` | high   |

## Pattern 1 — Cloud PC fleet audit

> _"How many Cloud PCs deployed and their status?"_

1. `list-cloud-pcs` → all CPCs.
2. Present: User | License (Windows 365 SKU) | Image | Provisioning policy | Status | Last login.
3. Flag:
   - CPCs `failed` or stuck in `provisioning` → investigate.
   - CPCs without recent login (wasted license).
4. Cross-reference with `list-subscribed-skus` (Windows 365) for cost analysis.

## Pattern 2 — Provisioning policy audit

> _"What provisioning policies exist?"_

1. `list-cloud-pc-provisioning-policies` → all policies.
2. For each: Image source, network connection, domain join type (Entra / Hybrid), assigned groups.
3. `list-cloud-pc-device-images` → verify image versions are current.
4. Flag policies using stale images.

## Pattern 3 — Audit events

> _"What happened on Cloud PCs this week?"_

1. `list-cloud-pc-audit-events` filtered on the time window.
2. Categorize by type (provisioning, deprovisioning, modify, restore).
3. Present as a timeline.

## Guardrails

- **`delete-cloud-pc-provisioning-policy` (high)** can affect already-provisioned CPCs (verify exact MS behavior). Always check assignments first.
- **Policy modifications** affect re-provisioning. Communicate with affected users before `update-`.

## Crosswalk

- Users assigned to CPCs → `usecase-identity.md`.
- Directory audit events related → `usecase-audit.md`.
