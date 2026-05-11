# usecase-intune — Devices, compliance, Autopilot, MAM, remote actions

**When to load:** managed fleet audit, lost / compromised device, MAM / MDM, Autopilot, compliance reports.

**Upstream references:** [USE_CASES.md §7 Intune compliance review](../../../docs/USE_CASES.md), [§8 Lost or compromised device](../../../docs/USE_CASES.md).

## Section A — Inventory and state

### Read

| Tool                                                                  | Usage                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `list-managed-devices`                                                | Intune device inventory. Filters: `complianceState`, `operatingSystem`, `osVersion`, `userPrincipalName`, `lastSyncDateTime`. |
| `get-managed-device`                                                  | Device detail.                                                                                                                |
| `list-device-compliance-states`                                       | Compliance state per device.                                                                                                  |
| `list-device-configuration-states`                                    | Config state per device.                                                                                                      |
| `get-managed-device-overview`                                         | Aggregated fleet view.                                                                                                        |
| `list-detected-apps`, `get-detected-app`, `list-detected-app-devices` | Detected apps and the devices that have them.                                                                                 |

### Write

| Tool                    | Risk                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `delete-managed-device` | **critical** — removes the object (does not wipe). Out-of-band escalation. |

## Section B — Compliance policies

| Tool                                                                                                                                                                   | Risk   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-compliance-policies`, `get-compliance-policy`, `list-compliance-policy-device-statuses`, `get-compliance-policy-status-overview`, `get-compliance-state-summary` | read   |
| `create-compliance-policy`, `update-compliance-policy`                                                                                                                 | medium |
| `delete-compliance-policy`                                                                                                                                             | high   |

## Section C — Device configurations

| Tool                                                                                                 | Risk   |
| ---------------------------------------------------------------------------------------------------- | ------ |
| `list-device-configurations`, `get-device-configuration`, `get-device-configuration-status-overview` | read   |
| `create-device-configuration`, `update-device-configuration`                                         | medium |
| `delete-device-configuration`                                                                        | high   |

## Section D — Enrollment and Autopilot

| Tool                                                                                                                                                  | Risk   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-enrollment-configurations`, `get-enrollment-configuration`, `list-autopilot-devices`, `get-autopilot-device`, `list-imported-autopilot-devices` | read   |
| `create-enrollment-configuration`, `update-enrollment-configuration`                                                                                  | medium |
| `delete-enrollment-configuration`                                                                                                                     | high   |
| `update-autopilot-device`                                                                                                                             | medium |
| `delete-autopilot-device`                                                                                                                             | high   |
| `import-autopilot-device`                                                                                                                             | medium |

## Section E — Remote device actions (incident-time)

**All POST writes. Several are critical/high.**

| Tool                            | Risk         | Effect                                                    |
| ------------------------------- | ------------ | --------------------------------------------------------- |
| `sync-managed-device`           | low          | Forces an Intune sync. Safe.                              |
| `locate-managed-device`         | low          | Geolocation (supervised iOS / Android).                   |
| `disable-lost-mode`             | low          | Exits lost mode on a device.                              |
| `trigger-defender-scan`         | low          | Triggers a Defender scan.                                 |
| `update-defender-signatures`    | low          | Forces signature update.                                  |
| `remote-lock-device`            | medium       | Remote lock.                                              |
| `logout-shared-apple-user`      | medium       | Sign out a Shared iPad user.                              |
| `update-windows-device-account` | medium       | Modifies the account on a Windows shared device.          |
| `reboot-managed-device`         | high         | Forced reboot — unsaved work lost.                        |
| `reset-device-passcode`         | high         | Reset passcode.                                           |
| `shutdown-managed-device`       | high         | Forced shutdown.                                          |
| `bypass-activation-lock`        | high         | Bypass iCloud activation lock.                            |
| `delete-shared-apple-user`      | high         | Remove a Shared iPad user.                                |
| `retire-managed-device`         | high         | Unenroll, remove corp data, retain personal data.         |
| `wipe-managed-device`           | **critical** | Factory reset — DATA DESTRUCTION. Out-of-band escalation. |
| `clean-windows-device`          | **critical** | Full Windows reset. Out-of-band escalation.               |

## Section F — RBAC, infra, terms

| Tool                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Usage |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `list-intune-audit-events`, `get-software-update-summary`, `get-apple-push-certificate`, `list-intune-role-definitions`, `list-intune-role-assignments`, `list-intune-terms-and-conditions`, `list-intune-terms-acceptances`, `get-intune-conditional-access-settings`, `list-mtd-connectors`, `list-ios-update-statuses`, `list-device-categories`, `list-compliance-management-partners`, `list-device-management-partners`, `list-exchange-connectors`, `list-remote-assistance-partners`, `list-notification-message-templates`, `list-intune-resource-operations`, `list-windows-malware-info` | read  |

## Section G — App management (MDM / MAM)

| Tool                                                                                                                                                                                                                                                                                                                                                                                       | Usage |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `list-intune-mobile-apps`, `list-intune-app-categories`, `list-intune-app-configurations`, `list-managed-app-policies`, `list-managed-app-registrations`, `list-managed-app-statuses`, `list-android-app-protections`, `list-ios-app-protections`, `list-default-app-protections`, `list-targeted-app-configurations`, `list-mdm-wip-policies`, `list-mam-wip-policies`, `list-vpp-tokens` | read  |

## Section H — Intune reports

⚠ **Intune reports use POST endpoints even when read-only.** The server exposes them, classified `low` (read-only in practice).

`intune-device-noncompliance-report`, `intune-compliance-policy-noncompliance-report`, `intune-compliance-policy-noncompliance-summary`, `intune-compliance-setting-noncompliance-report`, `intune-config-policy-noncompliance-report` / `*-summary`, `intune-config-setting-noncompliance-report`, `intune-devices-without-compliance-report`, `intune-noncompliant-devices-settings-report`, `intune-policy-noncompliance-report` / `*-summary` / `*-metadata`, `intune-setting-noncompliance-report`, `intune-report-filters`, `intune-historical-report`, `intune-cached-report`, `list-intune-report-export-jobs`, `intune-device-app-install-status-report`.

## Pattern 1 — Fleet non-compliance audit

> _"How many non-compliant devices and why?"_

1. `get-compliance-state-summary` → overall view.
2. `intune-device-noncompliance-report` → detailed list.
3. `intune-policy-noncompliance-summary` → top causing policies.
4. `intune-compliance-setting-noncompliance-report` → top causing settings.
5. Present: OS distribution, top causes, top impacted users, % fleet compliant.

## Pattern 2 — Lost device (containment sequence)

> _"User `jdoe@contoso.com` lost their iPhone."_

### Step 1 — Identify the device

```
list-user-devices(userId="jdoe@contoso.com")
list-managed-devices($filter="userPrincipalName eq 'jdoe@contoso.com'")
```

Identify the iPhone (model, lastSyncDateTime).

### Step 2 — Locate (low, OK direct)

```
locate-managed-device(managedDeviceId=<id>)
```

If successful → return coordinates. User may attempt recovery.

### Step 3 — Lock (medium → confirmation)

```
remote-lock-device(managedDeviceId=<id>)
```

Confirm with operator before invoking. Effect: immediate lock.

### Step 4 — If not recovered within 24h

Present the options:

- **`retire-managed-device` (high)** — recommended. Unenrolls, removes corp data, keeps personal data (photos, etc.) if the device is recovered.
- **`wipe-managed-device` (critical)** — full factory reset. **Out-of-band escalation required.** Permanent loss of all data.

For `retire`, explicit confirmation. For `wipe`, escalation — prepare the dry-run without executing.

### Step 5 — Audit + ticket

```
list-intune-audit-events($filter="<window>" + target)
```

File the ticket in your tracker (helpdesk for lost device, security incident for suspected compromise / theft).

## Pattern 3 — APNs expiration tracking

> _"Is the Apple Push certificate about to expire?"_

1. `get-apple-push-certificate` → expiration date.
2. If `< 60d`, file a renewal task with the platform owner.

## Guardrails

- **`wipe-managed-device` and `clean-windows-device`** — out-of-band escalation, never autonomous.
- **`retire-managed-device`** — explicit confirmation. Validate with the operator that `retire` (corp data only) is sufficient vs. `wipe`.
- **Mass compliance / config policy modifications** — never tighten policy via `update-compliance-policy` without prior communication. Risk of blocking hundreds of devices.
- **Large reports** — paginate and filter aggressively. The server may time out on large tenants.

## Crosswalk

- Device owner → `usecase-identity.md`.
- Combined account + device compromise → `usecase-response.md` + this file.
- BitLocker recovery key → `usecase-infoprotection.md`.
