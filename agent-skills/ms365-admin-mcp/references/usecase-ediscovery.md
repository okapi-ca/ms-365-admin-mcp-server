# usecase-ediscovery — Microsoft Purview eDiscovery

**When to load:** formal Legal / HR request, investigation with preservation, holds, custodians, eDiscovery searches.

⚠ **High legal and confidentiality impact.** Always validate the legal basis (formal HR request, documented Legal request, signed consent) **before** executing any action.

**Upstream references:** [USE_CASES.md §11 eDiscovery — legal investigation](../../../docs/USE_CASES.md).

## Tools in scope

### Read

| Tool                         | Usage                 |
| ---------------------------- | --------------------- |
| `list-ediscovery-cases`      | Existing cases.       |
| `get-ediscovery-case`        | Case detail.          |
| `list-ediscovery-custodians` | Custodians on a case. |
| `list-ediscovery-searches`   | Searches on a case.   |

### Write

These require `--allow-writes`.

| Tool                               | Risk                                                         |
| ---------------------------------- | ------------------------------------------------------------ |
| `create-ediscovery-case`           | medium                                                       |
| `update-ediscovery-case`           | medium                                                       |
| `delete-ediscovery-case`           | **critical** — out-of-band escalation. Evidence destruction. |
| `close-ediscovery-case`            | medium                                                       |
| `reopen-ediscovery-case`           | medium                                                       |
| `create-ediscovery-custodian`      | medium                                                       |
| `apply-hold-ediscovery-custodian`  | high                                                         |
| `remove-hold-ediscovery-custodian` | high                                                         |
| `create-ediscovery-search`         | medium                                                       |

## Mandatory pattern for any eDiscovery action

```
1. CONFIRM legal basis (who requested, what authority, written reference)
2. NOTIFY privacy officer / legal counsel as appropriate
3. DRY-RUN: prepare parameters
4. EXPLICIT CONFIRMATION with the operator
5. EXECUTE ONE ACTION AT A TIME
6. DOCUMENT each action in your case tracker
```

## Pattern 1 — Creating a formal case

> _"Create an eDiscovery case for HR investigation HR-INV-2026-014."_

### Step 1 — Pre-checks

- [ ] Written HR / Legal request received (reference).
- [ ] Privacy officer informed (priority in GDPR / other regulated jurisdictions).
- [ ] Custodians identified with exact UPNs.
- [ ] Keywords and time window defined.
- [ ] Hold decision: yes / no (impacts retention).

### Step 2 — Create the case

```
create-ediscovery-case(
  displayName="HR-INV-2026-014",
  description="<reference to HR/Legal request>"
)
```

Confirmation required. Document the returned `caseId` in your case tracker.

### Step 3 — Add custodians

```
create-ediscovery-custodian(caseId=..., email="alice@contoso.com", ...)
```

⚠ The custodian is **notified by default**. If the investigation requires non-notification (suspected exfiltration), disable notification and `applyHoldToSources` initially, then apply hold after preservation. Verify parameters with your legal counsel.

### Step 4 — Apply holds (high)

```
apply-hold-ediscovery-custodian(caseId=..., custodianId=...)
```

**Explicit confirmation**: _"I'm about to apply a hold on `alice@contoso.com`'s mailbox and OneDrive. This blocks any deletion until the hold is released. Confirm?"_

### Step 5 — Create searches

```
create-ediscovery-search(
  caseId=...,
  displayName="Search-1-keywords",
  contentQuery="(project-atlas OR confidential-merger) AND (sent>=2025-01-01 AND sent<=2025-12-31)",
  ...
)
```

KQL eDiscovery — see Purview documentation.

### Step 6 — Documentation

Case tracker entry (restricted access):

```
Title: [EDISCOVERY] HR-INV-2026-014
Link to the Purview case (caseId)
Custodians + holds applied
Searches created
Requester, date
```

## Pattern 2 — Add a custodian to an existing case

> _"Add `bob@contoso.com` to case HR-INV-2026-014."_

1. `get-ediscovery-case` → confirm case and status (`active`).
2. `list-ediscovery-custodians` → verify bob isn't already a custodian.
3. `create-ediscovery-custodian` → confirmation.
4. If hold required, `apply-hold-ediscovery-custodian` (high) → separate confirmation.
5. Update the case tracker.

## Pattern 3 — Release a hold

> _"Investigation is closed — release holds on case HR-INV-2026-014."_

1. **Written Legal / HR confirmation** that holds may be released.
2. `list-ediscovery-custodians` → all custodians with active hold.
3. For each, `remove-hold-ediscovery-custodian` (high) → confirm per case.
4. Optional: `close-ediscovery-case` (medium) → confirmation.
5. **Never** `delete-ediscovery-case` even after close — preserve for legal audit. That tool is critical, out-of-band escalation, and almost never justified.

## Guardrails

- **`delete-ediscovery-case` (critical)** — out-of-band escalation required. Evidence destruction, potential legal exposure. Almost never justified.
- **`apply-hold-` and `remove-hold-`** — direct impact on user retention. No application / release without Legal documentation.
- **Custodian notification** — default behavior notifies the custodian. For covert holds, verify parameters exactly.
- **Overly broad searches** — avoid `contentQuery` that returns massive volumes and creates over-collection risk. Prefer iterative refinement.

## Privacy officer / legal counsel involvement

For any eDiscovery operation in a regulated jurisdiction (GDPR / EU, PIPEDA / Canada, etc.), the privacy officer should be:

- **Informed** at case creation.
- **Consulted** for covert holds.
- **Signatory** on hold release in GDPR jurisdictions.

## Crosswalk

- Account identification → `usecase-identity.md`.
- Audit of custodian's actions → `usecase-audit.md`.
- Concurrent compromise → `usecase-response.md` (but preserve evidence BEFORE containment if legally required).
