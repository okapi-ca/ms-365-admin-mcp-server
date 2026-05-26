# Microsoft Graph metered APIs — current state (2026-05-26)

Quick reference for which Graph APIs exposed by `ms-365-admin-mcp-server` require **billing setup** (Azure subscription association) or **special licensing**.

## TL;DR for LCI

- **Teams chat APIs (Chat.Read.All, ChatMessage.Read.All, etc.)**: **FREE** since 2025-08-25. No setup needed.
- **Teams meeting recordings / transcripts content download**: still metered via `model=A` (license-based) or `model=B` (per-call billing).
- **SharePoint `assignSensitivityLabel`**: $0.00185 USD per call, requires Azure subscription association.
- **Everything else**: not metered.

LCI doesn't currently need to set up the Azure billing association — none of the tools exposed by this MCP hit the metered path in the way that triggers charges (we don't expose `assignSensitivityLabel`, and the chat / meeting tools either are no longer metered or use `model=A` which is included with the user's M365 E5 license).

If we add `download-meeting-recording-content` or `download-meeting-transcript-content` tools in a future PR, we'll need to revisit this — model=A (preferred) requires the target user to have a Microsoft Communications DLP service plan license (included in E5 / Office 365 E5 / Microsoft 365 E5 Compliance).

## Historical context

Before 2025-08-25, Microsoft's "Teams Export APIs" (chat content reads at scale via application permissions) were metered at ~\$0.75 / 1000 messages. This was the "per-message billing" mentioned in some Microsoft docs and third-party blog posts. **That billing model ended on 2025-08-25.**

If you read older documentation, blog posts, or third-party guides recommending "Protected APIs enrollment" or "Azure subscription billing setup" specifically for the Teams chat APIs — that advice is now obsolete for chat content. The recommendation may still apply for the `assignSensitivityLabel` API and for meeting recordings/transcripts content (see below).

## Currently metered APIs in Microsoft Graph (as of 2026-05-26)

Per [Microsoft Graph metered API list](https://learn.microsoft.com/graph/metered-api-list):

| API                                       | Price                 | Exposed by this server? |
| ----------------------------------------- | --------------------- | ----------------------- |
| `POST /drives/.../assignSensitivityLabel` | $0.00185 USD per call | ❌ Not exposed          |

## Conditionally-priced APIs — Teams meetings recordings + transcripts

Per [Payment models and licensing requirements for Microsoft Teams APIs](https://learn.microsoft.com/graph/teams-licenses):

| API                                                                                         | Pricing                                                                                              | Exposed by this server?                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `GET /users/{userId}/onlineMeetings/{meetingId}/recordings/{recordingId}/content`           | `model=A` (free with Microsoft Communications DLP service plan / E5) or `model=B` (per-call billing) | ❌ Not exposed (recordings content download)  |
| `GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/content`         | Same as above                                                                                        | ❌ Not exposed (transcripts content download) |
| `GET /users/{userId}/onlineMeetings/{meetingId}/transcripts/{transcriptId}/metadataContent` | Same as above                                                                                        | ❌ Not exposed                                |
| `GET /copilot/users/{userId}/onlineMeetings/{meetingId}/aiInsights/{aiInsightId}`           | Same as above                                                                                        | ❌ Not exposed                                |

For these APIs, the user being investigated (the target of `/users/{userId}/`) must have a license that includes the Microsoft Communications DLP service plan for `model=A`. Without that, you must pass `model=B` and accept the per-call billing.

**At LCI**: most staff with Teams access are on M365 A1 (Faculty/Staff), A3, or A5 (admins). Only A5 includes the DLP service plan. If we ever add recording/transcript content tools, queries on A1/A3 users will fail with 402 unless we pass `model=B`.

## What the LCI tenant currently consumes

Across the 600+ tools in this MCP, **only the `Chat.Read.All` + `ChatMessage.Read.All` + `ChatMember.Read.All` path was historically metered**, and that was removed by Microsoft on 2025-08-25.

No active metered consumption.

## If we add recording/transcript content tools later

A future PR adding `download-meeting-recording-content` or `download-meeting-transcript-content` would need to:

1. Document the `model=A` vs `model=B` choice in the tool's `llmTip`.
2. Add an `Authorization`-like decision: query the user's licenses first (already supported via `list-user-memberships`), determine if they have the DLP service plan, choose `model=A` if yes, `model=B` (with explicit user consent) if no.
3. If `model=B` is acceptable: configure Azure subscription billing per [Enable metered Microsoft 365 APIs and services](https://learn.microsoft.com/graph/metered-api-setup).

## Configuring billing if ever needed

Source: [Enable metered Microsoft 365 APIs and services](https://learn.microsoft.com/graph/metered-api-setup)

```
1. Have an active Azure subscription in the LCI tenant.
2. Application registration owner (Marc / IT admin) +
   subscription contributor or owner.
3. In the Azure portal:
   - Subscriptions → <your subscription> → Resource providers →
     register `Microsoft.GraphServices`
   - Subscriptions → <your subscription> → Access control (IAM) →
     Add role assignment → "Reader" on subscription scope to the
     app registration's service principal
4. In the Microsoft Entra admin center:
   - Applications → App registrations → <app name> →
     Billing → "Use this subscription for billing of metered APIs"
   - Select the LCI subscription
5. Verify with:
   GET https://graph.microsoft.com/v1.0/applications/{id}?$select=billingScope
```

This setup is **not required** for the current set of tools exposed by `ms-365-admin-mcp-server@0.12.0+`. Re-evaluate when adding meeting content download tools.

## References

- [Metered APIs and services in Microsoft Graph (current list)](https://learn.microsoft.com/graph/metered-api-list)
- [Enable metered APIs and services in Microsoft Graph (billing setup)](https://learn.microsoft.com/graph/metered-api-setup)
- [Payment models and licensing requirements for Microsoft Teams APIs (recordings + transcripts)](https://learn.microsoft.com/graph/teams-licenses)
- [Metered APIs and services FAQ](https://learn.microsoft.com/graph/metered-api-faq)
- [Export content with the Microsoft Teams Export APIs](https://learn.microsoft.com/microsoftteams/export-teams-content)
