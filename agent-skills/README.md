# Agent skills

Drop-in skills for LLM agents that operate `ms-365-admin-mcp-server`. Skills wrap the server's 515 tools with a structured safety pattern (dry-run → confirm → audit) and route requests by use case to keep the model focused on the right subset.

## Available skills

| Skill                                  | Purpose                                                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [`ms365-admin-mcp/`](ms365-admin-mcp/) | Reference skill for tenant-scoped administration: security triage, identity, Intune, Conditional Access, eDiscovery, hunting, governance. |

## How skills relate to the rest of the docs

Skills are an **operating layer** on top of the server, oriented at LLM clients. They complement the existing documentation rather than replacing it:

- [`docs/USE_CASES.md`](../docs/USE_CASES.md) — canonical list of 15 admin scenarios with sample prompts.
- [`docs/playbooks/`](../docs/playbooks/README.md) — end-to-end incident response procedures.
- [`docs/RISK_MODEL.md`](../docs/RISK_MODEL.md) — risk classification rubric for write tools.
- This directory — agent-loadable skills that index those docs by use case and enforce the safety pattern on every mutation.

## Installing a skill

### Claude Code

1. Copy the skill directory into your project's `.claude/skills/` (or your global `~/.claude/skills/`):
   ```bash
   cp -r agent-skills/ms365-admin-mcp ~/.claude/skills/
   ```
2. Restart Claude Code. The skill auto-loads when the conversation matches its `description` field.

### Other clients

The skill format is portable. The `SKILL.md` file is plain markdown with YAML frontmatter (`name`, `description`). Reference files under `references/` are lazy-loaded — the main `SKILL.md` indexes them and the model loads one at a time as needed. Most modern agent runtimes can ingest this structure directly.

## Contributing a skill

When proposing a new skill:

1. Place it under `agent-skills/<skill-name>/`.
2. Keep `SKILL.md` under ~200 lines — it's loaded at the start of every relevant conversation.
3. Use `references/<topic>.md` for domain-specific guidance, lazy-loaded one at a time.
4. Anonymize all examples (`@contoso.com`, generic role names — no real users, no tenant-specific deployment details).
5. Link to authoritative server docs (`docs/USE_CASES.md`, `docs/playbooks/`, `docs/RISK_MODEL.md`) rather than duplicating their content.
6. For any tool reference, confirm the tool exists in [`src/endpoints.json`](../src/endpoints.json).
