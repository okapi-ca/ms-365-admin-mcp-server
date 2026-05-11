# usecase-callrecords — Teams call records and PSTN

**When to load:** Teams call investigation, call quality analysis, PSTN audit, direct routing.

## Tools in scope

| Tool                                                           | Usage               |
| -------------------------------------------------------------- | ------------------- |
| `list-call-records`                                            | Teams calls.        |
| `get-call-record`                                              | Call detail.        |
| `list-call-record-sessions`, `get-call-record-session`         | Sessions of a call. |
| `list-call-session-segments`, `get-call-session-segment`       | Segments.           |
| `list-call-record-participants`, `get-call-record-participant` | Participants.       |
| `get-call-record-organizer`                                    | Organizer.          |
| `get-pstn-calls`                                               | PSTN calls.         |
| `get-direct-routing-calls`                                     | Direct Routing.     |

All read-only.

## Pattern 1 — Call quality investigation

> _"User reports a bad call yesterday at 2 p.m."_

1. `list-call-records` filtered on `participants/any(p: p.identity.user.id eq <user-id>)` and the time window.
2. `get-call-record` → metadata.
3. `list-call-record-sessions` → sessions of the call.
4. `list-call-session-segments` → per-segment metrics (jitter, packet loss, codec).
5. Identify degraded segments, present to the requester.

## Pattern 2 — PSTN / Direct Routing audit

> _"PSTN call audit for the month."_

1. `get-pstn-calls` filtered on the monthly window.
2. Aggregate: total duration, calls per user, destinations.
3. For Direct Routing, `get-direct-routing-calls`.
4. Reporting to Finance / Telecom.

## Guardrails

- No writes, but call records contain **communication data** (who called whom, when, duration). High confidentiality, especially for executives.
- Don't distribute without a legitimate basis.

## Crosswalk

- User involved → `usecase-identity.md`.
- Investigation potentially linked to an incident → `usecase-response.md`.
