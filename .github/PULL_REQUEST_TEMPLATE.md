<!-- Thanks for contributing to ms-365-admin-mcp-server. Please fill in the sections below. -->

## Summary

<!-- 1-3 bullet points: what changed and why. -->

## Type of change

<!-- Check one. -->

- [ ] `feat` — new tool, preset, or feature
- [ ] `fix` — bug fix
- [ ] `sec` — security fix
- [ ] `docs` — documentation only
- [ ] `chore` — tooling, deps, non-functional
- [ ] `refactor` — no behavior change
- [ ] `test` — tests only

## Tool inventory impact (if applicable)

<!-- If this PR adds or removes tools, fill this in. -->

- Tool count before: `___` → after: `___`
- New tools: <!-- list names -->
- Removed / renamed tools: <!-- list names and reason -->
- New preset(s): <!-- if any -->

## Risk assessment (required for new write tools)

<!-- See docs/RISK_MODEL.md. -->

| Tool | riskLevel | Reversibility | Blast radius | Justification |
| ---- | --------- | ------------- | ------------ | ------------- |
|      |           |               |              |               |

## Graph API permissions

<!-- List any new application permissions required. Prefer least privilege. -->

- [ ] No new permissions required
- New permissions:
  - `...`

## Testing

<!-- How did you verify this works? -->

- [ ] `npm run verify` passes locally
- [ ] Manual test against a real tenant (describe briefly)
- [ ] New unit tests added
- [ ] Not applicable (docs-only, etc.)

## Documentation

- [ ] `README.md` tool tables updated (if tool count changed)
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] `docs/USE_CASES.md` updated (if a new typical scenario emerges)
- [ ] Not applicable

## Security checklist

- [ ] No secrets, tokens, or tenant IDs committed
- [ ] New write tools carry a `riskLevel` in `endpoints.json`
- [ ] New permissions are the minimum required (no `.ReadWrite.All` when `.Read.All` suffices)
- [ ] No bypass of existing `SEC-*` defenses in `src/`

## Additional context

<!-- Anything a reviewer should know: related issues, rollout plan, follow-ups. -->
