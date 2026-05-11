# Tools catalogue

Index of the 515 tools exposed by `ms-365-admin-mcp-server`, organized by preset and by risk level. **Do not preload this file** — prefer the per-domain `usecase-*.md` files. This is a reference for cross-cutting questions ("what's critical across the server?", "which preset contains tool X?").

## Source of truth

This catalogue mirrors the presets defined in [`src/tool-categories.ts`](../../../src/tool-categories.ts) and the risk levels in [`docs/RISK_MODEL.md`](../../../docs/RISK_MODEL.md). For the exact list of tools exposed by a running server:

```bash
node dist/index.js --list-tools
node dist/index.js --list-permissions  # show required Graph permissions
```

## Index by preset

| Preset            | Description                                                               | Use case file                                   |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `security`        | Alerts, incidents, attack simulations, threat intel                       | `usecase-security.md`, `usecase-threatintel.md` |
| `audit`           | Directory audits, sign-ins, provisioning logs, deleted items              | `usecase-audit.md`                              |
| `health`          | Service health, Message Center                                            | `usecase-health.md`                             |
| `reports`         | Usage reports (Teams, Email, SP, OD, M365 Apps)                           | `usecase-reports.md`                            |
| `identity`        | Users, groups, roles, devices, PIM, guests, external identities           | `usecase-identity.md`                           |
| `exchange`        | Message traces, mailboxes                                                 | `usecase-exchange.md`                           |
| `intune`          | Devices, compliance, configurations, Autopilot, apps, RBAC                | `usecase-intune.md`                             |
| `governance`      | Access reviews, entitlement, lifecycle workflows, terms of use            | `usecase-governance.md`                         |
| `compliance`      | Licenses, Secure Score, Identity Protection, risk detections, CA policies | `usecase-compliance.md`                         |
| `response`        | Incident response writes (disable, revoke, confirm, dismiss)              | `usecase-response.md`                           |
| `ediscovery`      | eDiscovery cases (Purview)                                                | `usecase-ediscovery.md`                         |
| `cloudpc`         | Cloud PC / Windows 365                                                    | `usecase-cloudpc.md`                            |
| `callrecords`     | Teams call records                                                        | `usecase-callrecords.md`                        |
| `print`           | Universal Print                                                           | `usecase-print.md`                              |
| `infoprotection`  | BitLocker, threat assessment, sensitivity labels                          | `usecase-infoprotection.md`                     |
| `sharepointadmin` | SharePoint tenant administration                                          | `usecase-sharepointadmin.md`                    |
| `retention`       | Records management                                                        | `usecase-retention.md`                          |

## Index by risk level (write tools)

### Critical — require out-of-band sign-off

The chat operator's confirmation is not enough for these. Prepare the dry-run, document the intended change, but route the actual execution through a formal change request.

- `delete-user`
- `delete-group`
- `delete-application`
- `delete-service-principal`
- `delete-conditional-access-policy`
- `delete-exchange-mailbox`
- `delete-ediscovery-case`
- `delete-team`
- `delete-managed-device`
- `wipe-managed-device`
- `clean-windows-device`
- `add-directory-role-member`
- `create-pim-role-assignment-request` (on privileged roles)
- `create-pim-role-eligibility-request`
- `disable-user-account` (on privileged or break-glass accounts)

### High — explicit confirmation + dry-run

- `revoke-user-sessions`
- `confirm-compromised-users`, `confirm-safe-users`, `dismiss-risky-users`
- `confirm-compromised-service-principals`, `dismiss-risky-service-principals`
- `delete-user-phone-auth-method`
- `change-user-password`
- `update-device`
- `create-conditional-access-policy`, `update-conditional-access-policy`
- `delete-named-location`
- `create-auth-strength-policy`, `update-auth-strength-policy`, `delete-auth-strength-policy`
- `update-application`, `update-service-principal`
- `add-application-password`, `remove-application-password`, `add-application-key`, `remove-application-key`
- `create-application`, `add-application-owner`, `remove-application-owner`
- `create-app-federated-credential`, `update-app-federated-credential`, `delete-app-federated-credential`
- `create-service-principal`, `add-sp-password`, `remove-sp-password`, `add-sp-key`, `remove-sp-key`, `add-sp-token-signing-certificate`, `add-sp-owner`, `remove-sp-owner`, `create-sp-app-role-assignment`
- `delete-administrative-unit`
- `create-domain`
- `apply-hold-ediscovery-custodian`, `remove-hold-ediscovery-custodian`
- `delete-cloud-pc-provisioning-policy`
- `retire-managed-device`, `reset-device-passcode`, `reboot-managed-device`, `shutdown-managed-device`, `bypass-activation-lock`, `delete-shared-apple-user`
- `delete-compliance-policy`, `delete-device-configuration`, `delete-enrollment-configuration`, `delete-autopilot-device`
- `update-teams-app-settings`
- `delete-team-admin-channel`
- `delete-site-list`, `delete-site-permission`
- `apply-access-review-decisions`, `stop-access-review-instance`, `reset-access-review-decisions`, `delete-access-review-definition`
- `activate-lifecycle-workflow`, `delete-lifecycle-workflow`, `delete-lifecycle-custom-task-extension`
- `delete-access-package`, `delete-access-package-catalog`, `delete-access-package-assignment-policy`
- `cancel-pim-role-assignment-request`, `cancel-pim-role-eligibility-request`
- `create-pim-group-assignment-request`, `create-pim-group-eligibility-request`
- `create-attack-simulation`
- `create-role-management-policy-assignment`, `update-role-management-policy`

### Medium — confirmation recommended

- `update-user`, `assign-user-license`
- `create-group`, `update-group`, `add-group-member`
- `create-administrative-unit`, `update-administrative-unit`, `add-administrative-unit-member`
- `verify-domain`
- `set-application-verified-publisher`
- `create-invitation`
- `create-named-location`, `update-named-location`
- `update-security-alert`, `update-security-incident`, `update-attack-simulation`, `delete-attack-simulation`
- `update-exchange-mailbox`, `export-exchange-mailbox-items`
- `create-compliance-policy`, `update-compliance-policy`
- `create-device-configuration`, `update-device-configuration`
- `create-enrollment-configuration`, `update-enrollment-configuration`, `update-autopilot-device`, `import-autopilot-device`
- `remote-lock-device`, `logout-shared-apple-user`, `update-windows-device-account`
- `update-sharepoint-site`, `delete-site-list-item`
- `create-site-permission`, `update-site-permission`
- `create-team`, `update-team`, `add-team-admin-members`, `remove-team-admin-members`, `archive-team`, `clone-team`
- `create-cloud-pc-provisioning-policy`, `update-cloud-pc-provisioning-policy`
- `create-ediscovery-case`, `update-ediscovery-case`, `close-ediscovery-case`, `reopen-ediscovery-case`, `create-ediscovery-custodian`, `create-ediscovery-search`
- `create-access-review-definition`, `update-access-review-definition`, `accept-access-review-recommendations`
- `create-access-package`, `update-access-package`, `create-access-package-catalog`, `update-access-package-catalog`, `create-access-package-assignment-policy`, `update-access-package-assignment-policy`, `create-access-package-assignment-request`, `cancel-access-package-assignment-request`
- `create-lifecycle-workflow`, `update-lifecycle-workflow`, `restore-lifecycle-workflow`, `create-lifecycle-custom-task-extension`, `update-lifecycle-custom-task-extension`
- `cancel-pim-group-assignment-request`, `cancel-pim-group-eligibility-request`

### Low — limited blast radius

- `add-security-alert-comment`
- `reprocess-user-license`
- `sync-managed-device`, `locate-managed-device`, `disable-lost-mode`, `trigger-defender-scan`, `update-defender-signatures`
- `unarchive-team`
- `create-team-admin-channel`
- `create-site-list`, `update-site-list`, `create-site-list-item`, `update-site-list-item`
- `send-reminder-access-review`
- `reprocess-access-package-assignment-request`
- `run-hunting-query` (POST but read-only in practice — KQL does not mutate state)
- Intune reports (POST endpoints, read-only in practice)
