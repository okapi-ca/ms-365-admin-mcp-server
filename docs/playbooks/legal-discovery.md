# Playbook — Legal discovery / subpoena response

Court-admissible production of user content (mailbox, OneDrive, SharePoint, Teams chats) for litigation, subpoena response, regulatory request, or internal investigation requiring chain-of-custody.

This playbook covers the **formal eDiscovery v3 workflow** that produces signed, chain-of-custody-preserving exports admissible in court.

> [!IMPORTANT]
> For preliminary investigations (look at recent activity before deciding whether to open a formal case), use the `list-chat-messages` / `list-user-chats` tools directly. Those are NOT court-admissible — they're rapid-triage tools. The moment the work moves toward potential litigation or regulatory production, switch to this playbook.

## Trigger signals

- Subpoena, court order, or government information request naming a specific employee.
- HR / Legal opens an internal investigation expected to result in disciplinary action or termination with potential litigation.
- Insurance carrier requests preservation of records for an in-progress claim.
- DPA / regulator (Commission d'accès à l'information du Québec, CNIL, ICO, etc.) issues a data subject request requiring complete content production.
- Internal audit identifies a need for forensic-grade content review (fraud, IP theft, harassment).

## Scope boundary

This server **can**:

- Create the eDiscovery case (`create-ediscovery-case`).
- Add the target user as a custodian (`create-ediscovery-custodian`).
- Apply legal hold to preserve content (`apply-hold-ediscovery-custodian`) — prevents deletion / purge regardless of retention policy.
- Add noncustodial data sources (shared mailboxes, departmental SharePoint sites, M365 group OneDrive) — `create-ediscovery-noncustodial-data-source` + `apply-hold-ediscovery-noncustodial-data-source`.
- Run KQL collection searches against Exchange + SharePoint + OneDrive + Teams chats (`create-ediscovery-search`).
- Track long-running collection / hold / export operations (`list-case-operations`, `get-case-operation`).
- Curate matches into review sets (`create-review-set`, `add-to-review-set`).
- Apply review tags (`create-review-set-query`, `apply-tags-review-set-query`).
- Export native files + extracted text + metadata + tags for production (`export-review-set`).

This server **cannot**:

- Provide the chain-of-custody attestation document itself — the Purview portal generates this; the MCP server only triggers the export action.
- Decrypt content protected by sensitivity labels with custom encryption (the export inherits the label's protection; the requesting party needs the decryption rights).
- Replace the **legal review** by counsel — `apply-tags-review-set-query` automates tag application based on KQL, but human review of "Privileged" tagging is still the responsibility of legal counsel.

Handoffs:

- **Microsoft Purview portal** — for downloading the export package after `export-review-set` completes (Graph does not return a direct download URL; you must download from the portal).
- **Outside counsel** — for review of "Privileged" tagged documents and final production decision.
- **Notarization** — if the receiving party requires notarized chain-of-custody, Microsoft's signed export package is normally sufficient, but local counsel may add a notary statement.

## Prerequisites

- App registration has these permissions consented (already done as of v0.11.0):
  - `eDiscovery.Read.All`
  - `eDiscovery.ReadWrite.All`
- Operator is granted the `eDiscovery Manager` or `eDiscovery Administrator` role in Microsoft Purview (Purview portal > Roles & scopes).
- Server is launched with `--allow-writes` and `--preset ediscovery,security` (or `all`).
- The target user account has not been deleted (legal hold cannot be applied to a deleted user — restore the soft-deleted account first if needed).
- An internal investigation reference / case number is available for the case displayName.

## Phased procedure

### Phase 1 — Open case and apply hold (PRESERVATION)

Goal: stop the clock on retention/purge for the target user's content, NOW.

| Step | Tool                          | Risk   | Notes                                                                                                                |
| ---- | ----------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `create-ediscovery-case`      | medium | `displayName`: "Subpoena <case-name> 2026", `description`: "Internal ref: HR-2026-NNN, Subpoena received YYYY-MM-DD" |
| 1.2  | `create-ediscovery-custodian` | medium | `email`: target user UPN, `applyHoldToSources`: `true` (applies hold immediately)                                    |
| 1.3  | `get-ediscovery-custodian`    | —      | Verify `status: active`, `holdStatus: applied`                                                                       |

> [!TIP]
> Step 1.2 with `applyHoldToSources: true` is the single most important call in this playbook. It preserves content immediately — if the user attempts to delete a chat or empty their Deleted Items, the content goes to the preservation hold library / dumpster and remains retrievable. Without this, evidence may be lost between case creation and search execution.

If additional non-user-owned data is in scope (shared mailbox, departmental site, M365 group):

| Step | Tool                                                              | Risk   |
| ---- | ----------------------------------------------------------------- | ------ |
| 1.4  | `create-ediscovery-noncustodial-data-source` (one per source)     | medium |
| 1.5  | `apply-hold-ediscovery-noncustodial-data-source` (one per source) | medium |

### Phase 2 — Collect (SEARCH)

Goal: identify the responsive content via KQL across all in-scope sources.

| Step | Tool                                             | Risk   | Notes                                                                                                                                                       |
| ---- | ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | `create-ediscovery-search`                       | medium | `displayName`: "Initial collection", `contentQuery`: KQL (see examples below), `dataSourceScopes`: `allCaseCustodians` (or include noncustodialDataSources) |
| 2.2  | `list-case-operations` then `get-case-operation` | —      | Poll until `action: estimateStatistics`, `status: succeeded`; result includes hit counts and size — review before proceeding to add-to-review-set           |

#### KQL example — Teams chats only

```kusto
kind:im AND received>=2024-01-01 AND received<=2024-12-31
```

#### KQL example — Teams chats with keyword filter

```kusto
kind:im AND received>=2024-01-01 AND
(subject:"contract" OR body:"confidential" OR body:"Smith")
```

#### KQL example — Cross-channel (mail + chats + files)

```kusto
(kind:email OR kind:im OR kind:document) AND
received>=2024-01-01 AND received<=2024-12-31
```

#### KQL example — Subject-rights request (broad time scope, no keyword)

```kusto
received>=1900-01-01
```

> [!NOTE]
> `kind:im` covers Teams 1:1, group, and meeting chats (stored in user mailbox via Substrate Storage). `kind:document` covers OneDrive + SharePoint + attached files in mail/chat. Sensitivity-labeled content is included automatically.

### Phase 3 — Collect into review set (CURATION)

Goal: snapshot the search results into an immutable review workspace.

| Step | Tool                                             | Risk   | Notes                                                                                                       |
| ---- | ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------- |
| 3.1  | `create-review-set`                              | low    | `displayName`: "<case-id> production batch 1"                                                               |
| 3.2  | `add-to-review-set`                              | medium | Body: `{ search: { id: <searchId> }, additionalDataOptions: "linkedFiles", itemsToInclude: "searchHits" }`  |
| 3.3  | `list-case-operations` then `get-case-operation` | —      | Poll until `action: addToReviewSet`, `status: succeeded`. Can take 30 min–several hours depending on volume |

> [!IMPORTANT]
> Once items are in the review set, they're immutable — they snapshot the source content at the time of add. Subsequent edits or deletions in the source don't propagate. This is the chain-of-custody anchor point.

### Phase 4 — Tag and filter for production (REVIEW)

Goal: separate Responsive / Non-Responsive / Privileged content per outside counsel's review.

| Step | Tool                                               | Risk   | Notes                                                                                                   |
| ---- | -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------- |
| 4.1  | `create-review-set-query`                          | low    | KQL filters inside the review set (e.g. `Tags:"Responsive"` after manual review, or pre-tag heuristics) |
| 4.2  | `apply-tags-review-set-query`                      | medium | Bulk-tag matching items as "Responsive", "Privileged", "Confidential", etc.                             |
| 4.3  | (Manual review in Purview portal by legal counsel) | —      | Outside the MCP — counsel reviews each item flagged "Potentially Privileged"                            |

Tag IDs are managed in the tenant's review tag taxonomy via the Purview portal (the MCP does not yet expose tag-taxonomy CRUD).

### Phase 5 — Export (PRODUCTION)

Goal: produce the deliverable archive admissible in court.

| Step | Tool                                             | Risk     | Notes                                                                                                                                      |
| ---- | ------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.1  | `create-review-set-query` (if not already)       | low      | KQL: `NOT Tags:"Privileged" AND NOT Tags:"Non-Responsive"`                                                                                 |
| 5.2  | `export-review-set`                              | **high** | Body: `{ outputName: "<case-id>-production-<YYYYMMDD>", exportOptions: "originalFiles,fileInfo,tags,text", exportStructure: "directory" }` |
| 5.3  | `list-case-operations` then `get-case-operation` | —        | Poll until `action: export`, `status: succeeded`. Export operations can take hours for large volumes                                       |
| 5.4  | (Manual download from Purview portal)            | —        | Graph does not return a direct download URL. Download the package from the Purview portal, capture the chain-of-custody manifest           |

`exportOptions` flags:

- `originalFiles` — native files in their original format
- `text` — extracted plain text (useful for review)
- `pdfReplacement` — PDF rendition for non-Office files (slower export)
- `tags` — CSV of items with their review tags
- `fileInfo` — metadata CSV (custodian, source, dates, hashes)
- `summary` — high-level statistics PDF

`exportStructure`:

- `none` — flat folder
- `directory` — per-custodian folders (recommended for multi-custodian cases)
- `pst` — mailbox-style PST per custodian (compatible with Outlook for review)

### Phase 6 — Documentation (CLOSE)

Goal: leave a complete audit trail.

| Step | Tool / system                                        | Notes                                                                                                                        |
| ---- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 6.1  | Internal investigation journal                       | Document: case number, target user(s), KQL query, hit count, export package hash, exporter name, date, recipient             |
| 6.2  | `update-ediscovery-case` (set status if needed)      | Mark the case as "closed" once production is delivered                                                                       |
| 6.3  | `close-ediscovery-case`                              | If the case is fully closed (no further production expected)                                                                 |
| 6.4  | Retain hold UNTIL the legal matter is fully resolved | Do NOT call `release-ediscovery-custodian` until counsel confirms the matter is closed and statute of limitations has passed |

Releasing hold prematurely means deleted items become eligible for permanent purge per the standard retention window (14-30 days mailbox dumpster, 93 days SharePoint Recycle Bin). Items deleted while on hold but past the standard retention window WILL be purged within days of release.

## Sample prompts

### Phase 1 — preservation

> Ouvre un dossier eDiscovery "Subpoena Smith vs Contoso 2026-05" pour le user jean.tremblay@contoso.com. Applique le legal hold sur ses mailbox, OneDrive et Teams chats. Confirme que le hold est appliqué.

### Phase 2 — collection

> Crée une recherche dans le dossier "Subpoena Smith vs Contoso 2026-05" qui capture tous les chats Teams de jean.tremblay entre 2024-01-01 et 2024-12-31 contenant les mots "contrat", "Smith" ou "confidentiel". Attends le résultat de l'estimation et donne-moi le hit count.

### Phase 3 — review set

> Crée un review set "Production batch 1" et ajoute les résultats de la recherche précédente avec les linkedFiles. Confirme quand l'opération est complétée.

### Phase 4 — tagging

> Crée une query "All items" dans le review set, et applique le tag "Responsive" à tous les items pour le moment. (Le tagging "Privileged" sera fait manuellement par le contentieux via le portail Purview.)

### Phase 5 — export

> Exporte le review set excluant les items tagués "Privileged" — outputName "Smith-2026-05-production-2026-05-26", format originalFiles + fileInfo + tags, structure per-custodian. Préviens-moi quand l'export est succeeded.

### Full-run single-shot prompt

> Démarre un workflow eDiscovery complet pour le subpoena reçu aujourd'hui visant jean.tremblay@contoso.com pour des chats Teams 2024 contenant "contrat" ou "Smith". Trace toutes les étapes : case → custodian + hold → search → wait → review set → addToReviewSet → wait → tag "Responsive" → export en format originalFiles+fileInfo+tags+text per-custodian. Confirme à chaque étape avant de passer à la suivante (les long-running ops peuvent prendre 30-60 min chacune).

## Demo talking points

What this playbook showcases that the others do not:

- **Chain-of-custody from API call**. The eDiscovery flow generates signed exports with metadata that withstand court scrutiny — this is NOT possible via direct `list-chat-messages` reads.
- **Legal hold as preservation, not surveillance**. The hold prevents deletion but does not modify content visibility for the user. The user still sees their normal Teams; deleted items go to the preservation library transparently.
- **Cross-source unified collection**. One KQL query covers mailbox + chats + group chats + meetings + OneDrive + SharePoint — no source-by-source dance.
- **Auditable scope by construction**. The case has a name, a custodian list, a search query, an export package — every step is logged in Purview audit. Reading chats outside this flow has no equivalent forensic trail.

## Differences from preliminary investigation flow

| Aspect              | Preliminary (`list-chat-messages`)                              | Formal (this playbook)                                                 |
| ------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Court admissibility | No chain-of-custody                                             | Signed export, chain-of-custody intact                                 |
| Microsoft pricing   | Per-message metered (Teams Export API) unless in Protected APIs | Included in M365 E5 (eDiscovery Premium)                               |
| Audit               | Graph API audit (basic)                                         | Purview eDiscovery audit (case + custodian + search + export linked)   |
| Preservation        | None — if user deletes, content is lost                         | Legal hold prevents purge                                              |
| Scope               | Per-user chats only                                             | Mailbox + chats + groups + meetings + OneDrive + SharePoint            |
| Speed               | Seconds                                                         | 30 min – hours per phase                                               |
| Use when            | Triage / decide whether to open formal case                     | Subpoena, litigation, regulatory request, HR with potential litigation |

## References

- Microsoft eDiscovery (Premium) overview: https://learn.microsoft.com/purview/ediscovery-overview
- Microsoft Graph eDiscovery API: https://learn.microsoft.com/graph/api/resources/security-ediscoverycase
- KQL for eDiscovery: https://learn.microsoft.com/purview/ediscovery-keyword-queries-and-search-conditions
- Teams content in eDiscovery: https://learn.microsoft.com/purview/ediscovery-search-and-delete-teams-chat
- Hold and preservation: https://learn.microsoft.com/purview/ediscovery-create-holds
