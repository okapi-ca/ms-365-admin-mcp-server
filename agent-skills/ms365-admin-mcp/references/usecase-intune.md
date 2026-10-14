# usecase-intune — Devices, compliance, Autopilot, MAM, remote actions

**When to load:** managed fleet audit, lost / compromised device, MAM / MDM, Autopilot, compliance reports, Endpoint security (BitLocker, Antivirus, Firewall, ASR) and Settings catalog policies.

**Upstream references:** [USE_CASES.md §7 Intune compliance review](../../../docs/USE_CASES.md), [§8 Lost or compromised device](../../../docs/USE_CASES.md).

## Section A — Inventory and state

### Read

| Tool                                                                  | Usage                                                                                                                                              |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-managed-devices`                                                | Intune device inventory. Filters: `complianceState`, `operatingSystem`, `osVersion`, `userPrincipalName`, `lastSyncDateTime`.                      |
| `get-managed-device`                                                  | Device detail (Graph beta). `hardwareInformation` (TPM, BIOS, VBS) and `deviceHealthAttestationState` (Secure Boot) come back only with `$select`. |
| `list-device-compliance-states`                                       | Compliance state per device.                                                                                                                       |
| `list-device-configuration-states`                                    | Config state per device.                                                                                                                           |
| `get-managed-device-overview`                                         | Aggregated fleet view.                                                                                                                             |
| `list-managed-device-encryption-states`                               | Intune encryption report: readiness, encryption state, TPM version, `advancedBitLockerStates`, policies that reached each device.                  |
| `get-windows-protection-state`                                        | Defender Antivirus health of one device: real-time and tamper protection, signature and scan age, detected malware.                                |
| `list-detected-apps`, `get-detected-app`, `list-detected-app-devices` | Detected apps and the devices that have them.                                                                                                      |

### Write

| Tool                    | Risk                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `delete-managed-device` | **critical** — removes the object (does not wipe). Out-of-band escalation. |

## Section B — Compliance policies

| Tool                                                                                                                                                                   | Risk   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-compliance-policies`, `get-compliance-policy`, `list-compliance-policy-device-statuses`, `get-compliance-policy-status-overview`, `get-compliance-state-summary` | read   |
| `create-compliance-policy`, `update-compliance-policy`                                                                                                                 | medium |
| `delete-compliance-policy`, `assign-compliance-policy`                                                                                                                 | high   |

## Section C — Device configurations

| Tool                                                                                                                                              | Risk   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-device-configurations`, `get-device-configuration`, `get-device-configuration-status-overview`, `list-device-configuration-device-statuses` | read   |
| `list-windows-feature-update-profiles`, `list-windows-quality-update-profiles`, `list-windows-quality-update-policies`                            | read   |
| `create-device-configuration`, `update-device-configuration`                                                                                      | medium |
| `delete-device-configuration`, `assign-device-configuration`                                                                                      | high   |

Classic profiles include the Windows Update for Business rings. Call `get-device-configuration` **without** `$select` to read a ring: `$select` only resolves the base `deviceConfiguration` type and fails with 400 on a ring property such as `qualityUpdatesDeferralPeriodInDays`. Feature and quality update profiles override a ring's deferrals, so read them too before explaining a device's update behaviour.

## Section C2 — Settings catalog and Endpoint security (Graph beta)

Every modern Endpoint security policy (Disk encryption / BitLocker, Antivirus, Firewall, Attack surface reduction, Account protection, EDR) is a Settings catalog policy. Older template-based profiles are **intents**. A tenant usually has both: check both before concluding a policy does not exist.

| Tool                                                                                                                                   | Risk   |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `list-configuration-policies`, `get-configuration-policy`, `list-configuration-policy-settings`, `list-configuration-policy-templates` | read   |
| `get-configuration-policy-device-status`, `get-configuration-policy-device-summary` (POST reports)                                     | low    |
| `list-intents`, `get-intent`, `list-intent-device-states`, `list-intent-templates`                                                     | read   |
| `create-configuration-policy`, `update-configuration-policy` (metadata only), `update-intent`, `update-intent-settings`                | medium |
| `delete-configuration-policy`, `assign-configuration-policy`, `delete-intent`, `assign-intent`                                         | high   |

Filter `list-configuration-policies` on `templateReference/templateFamily` (for example `endpointSecurityDiskEncryption`) to find every Endpoint security policy of one kind. In `$expand=assignments`, the target's `@odata.type` tells an inclusion (`groupAssignmentTarget`) from an exclusion (`exclusionGroupAssignmentTarget`). **Every `assign-*` action replaces the whole assignment list**: read the current assignments first and send them back with the change, or the groups left out are silently unassigned.

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
| `rotate-bitlocker-keys`         | medium       | Rotates the BitLocker recovery password after disclosure. |
| `rotate-local-admin-password`   | medium       | Rotates the Windows LAPS password after disclosure.       |
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
| `list-device-health-script-run-states`, `get-device-health-script-run-summary` — Remediation results per device and in aggregate                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | read  |

## Section G — App management (MDM / MAM)

| Tool                                                                                                                                                                                                                                                                                                                                                                                       | Usage |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `list-intune-mobile-apps`, `list-intune-app-categories`, `list-intune-app-configurations`, `list-managed-app-policies`, `list-managed-app-registrations`, `list-managed-app-statuses`, `list-android-app-protections`, `list-ios-app-protections`, `list-default-app-protections`, `list-targeted-app-configurations`, `list-mdm-wip-policies`, `list-mam-wip-policies`, `list-vpp-tokens` | read  |

## Section H — Intune reports

⚠ **Intune reports use POST endpoints even when read-only.** The server exposes them, classified `low` (read-only in practice).

`intune-device-noncompliance-report`, `intune-compliance-policy-noncompliance-report`, `intune-compliance-policy-noncompliance-summary`, `intune-compliance-setting-noncompliance-report`, `intune-config-policy-noncompliance-report` / `*-summary`, `intune-config-setting-noncompliance-report`, `intune-devices-without-compliance-report`, `intune-noncompliant-devices-settings-report`, `intune-policy-noncompliance-report` / `*-summary` / `*-metadata`, `intune-setting-noncompliance-report`, `intune-report-filters`, `intune-historical-report`, `intune-cached-report`, `list-intune-report-export-jobs`, `intune-device-app-install-status-report`.

Graph returns at most 50 rows per call from these actions, whatever `top` says. Pass `allPages: true` and the server walks `skip` until `TotalRowCount`, returning one table with a `pagination` block; `dedupeBy` (e.g. `DeviceName`) drops repeated rows. The walk stops at `MS365_ADMIN_MCP_REPORT_MAX_ROWS` (default 5000) and reports `truncated: true`; a failed page fails the whole call. The two Settings catalog reports in Section C2 accept the same arguments.

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

## Pattern 4 — Where does disk encryption fail?

> _"Which devices are not encrypted, and is a BitLocker policy even targeting them?"_

1. `list-managed-device-encryption-states` → encryption state, readiness and TPM version per device.
2. `list-configuration-policies($filter="templateReference/templateFamily eq 'endpointSecurityDiskEncryption'", $expand=assignments)` → the BitLocker policies and the groups each targets; `list-intents` for template-based ones.
3. `get-configuration-policy(…, $expand=settings)` → what each policy actually enforces (encryption method, startup authentication).
4. `get-configuration-policy-device-status(allPages: true)` with filter `(PolicyId eq '<id>') and (PolicyBaseTypeName eq 'DeviceManagementConfigurationPolicy')` → per-device result of each policy. Without the `PolicyBaseTypeName` clause Graph answers 400.
5. Present: unencrypted devices with no policy, devices targeted but failing (with the error), devices not capable (no TPM).

## Guardrails

- **`wipe-managed-device` and `clean-windows-device`** — out-of-band escalation, never autonomous.
- **`retire-managed-device`** — explicit confirmation. Validate with the operator that `retire` (corp data only) is sufficient vs. `wipe`.
- **Mass compliance / config policy modifications** — never tighten policy via `update-compliance-policy` without prior communication. Risk of blocking hundreds of devices.
- **Large reports** — filter first, then use `allPages: true` rather than paging by hand. Raise `MS365_ADMIN_MCP_REPORT_MAX_ROWS` only for a deliberate full export.
- **`assign-*` on any policy** — Graph replaces the whole assignment list. Read the current assignments and send the full list back.

## Crosswalk

- Device owner → `usecase-identity.md`.
- Combined account + device compromise → `usecase-response.md` + this file.
- BitLocker recovery key → `usecase-infoprotection.md`.
