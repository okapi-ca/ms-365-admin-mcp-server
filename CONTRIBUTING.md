# Contributing

Thanks for your interest in contributing to `ms-365-admin-mcp-server`.

## Ground rules

- **No breaking changes** to tool names, parameter shapes, or preset categories without discussion. MCP clients rely on stable tool identifiers.
- **Security-first mindset.** Every new write operation must be classified with a risk level (`low`/`medium`/`high`/`critical`) and require `--allow-writes`.
- **Least privilege.** New tools must declare the minimum Graph API permissions (`appPermissions` in `endpoints.json`). Never request `.ReadWrite.All` when `.Read.All` suffices.
- **Tests and lint must pass** before PR merge (`npm run verify`).

## Development setup

```bash
git clone https://github.com/okapi-ca/ms-365-admin-mcp-server.git
cd ms-365-admin-mcp-server
npm install
npm run generate    # Download Graph OpenAPI spec and generate client
npm run build
npm test
```

Create a local `.env` with your Azure AD app registration credentials:

```
MS365_ADMIN_MCP_CLIENT_ID=...
MS365_ADMIN_MCP_CLIENT_SECRET=...
MS365_ADMIN_MCP_TENANT_ID=...
```

Run the server interactively with the MCP Inspector:

```bash
npm run inspector
```

## Project layout

```
bin/                  Code-generation scripts (OpenAPI -> zod client)
src/
  auth.ts             MSAL client credentials flow
  cli.ts              Commander argv parsing
  cloud-config.ts     Global vs China (21Vianet) endpoints
  endpoints.json      Source of truth for tool definitions
  generated/          Auto-generated zod client (do not edit)
  graph-client.ts     Graph API fetch wrapper
  graph-tools.ts      MCP tool registration
  http-server.ts      Express + StreamableHTTP transport
  index.ts            Entry point
  logger.ts           Winston logger
  secrets.ts          env / Key Vault secret providers
  server.ts           Stdio server and tool wiring
  token-validator.ts  JWT validation for HTTP mode
  tool-categories.ts  Preset definitions
infra/
  main.bicep          Azure Container Apps deployment
test/                 Vitest specs
```

## Adding a new tool

1. **Find the Graph API endpoint** in the [Microsoft Graph OpenAPI spec](https://github.com/microsoftgraph/msgraph-metadata).
2. **Add an entry** to `src/endpoints.json`:

   ```jsonc
   {
     "toolName": "list-something",
     "pathPattern": "/something",
     "method": "GET",
     "appPermissions": ["Something.Read.All"],
     "llmTip": "Optional hint shown to the LLM in the tool description",
     "riskLevel": "low" // only for non-GET
   }
   ```

3. **Regenerate the client**:

   ```bash
   npm run generate
   ```

4. **Verify** the tool is registered and permissions are correct:

   ```bash
   node dist/index.js --list-tools | grep list-something
   node dist/index.js --list-permissions | grep Something
   ```

5. **Add a test** if the tool has non-trivial parameter handling or skipEncoding rules.

6. **Update `README.md`** tool tables to reflect the new count and category.

### Risk classification rubric

Use this rubric for non-GET operations:

| Level      | Criteria                                                                  | Examples                                                              |
| ---------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `low`      | Read-only in effect (POST-only queries, reports) or trivial annotations   | `run-hunting-query`, `add-security-alert-comment`, Intune reports     |
| `medium`   | Reversible mutation affecting a single entity                             | `update-user`, `add-group-member`, `create-invitation`                |
| `high`     | Significant impact: broad scope, credential change, or destructive+       | `revoke-user-sessions`, `update-conditional-access-policy`            |
| `critical` | Irreversible or tenant-wide impact                                        | `delete-user`, `wipe-managed-device`, `delete-conditional-access-policy` |

When in doubt, pick the higher level.

## Adding a new preset

Edit `src/tool-categories.ts`:

```ts
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  mypreset: {
    name: 'mypreset',
    pattern: /pattern-matching-tool-names/i,
    description: 'Short human-readable description',
  },
  // ...
};
```

Regex must match `toolName`s in `endpoints.json`. Validate with:

```bash
node dist/index.js --preset mypreset --list-tools
```

## Coding style

- **TypeScript strict mode.** No `any` without justification.
- **No new runtime dependencies** without discussion. Prefer standard library.
- **Prettier + ESLint** must pass (`npm run format:check` and `npm run lint`).
- **Comments explain why, not what.** Name things well instead.

## Commit and PR conventions

Commit prefixes:

- `feat:` new tool, preset, or feature
- `fix:` bug fix
- `sec:` security fix (document in `SECURITY.md` if externally reported)
- `docs:` documentation only
- `chore:` tooling, deps, non-functional
- `refactor:` no behavior change
- `test:` tests only
- `build(deps):` / `build(deps-dev):` dependency bumps (Dependabot format)

Examples from the project history:

```
feat: add 71 admin write endpoints (444->515 tools)
sec: sanitize query strings and testLogin error leaks
chore: bump verified-publisher risk and remove dead dep
```

### Pull requests

- Keep PRs focused. One feature or fix per PR.
- Include a summary of what changed, why, and how it was tested.
- For new tools, attach a sample prompt demonstrating usage.
- For write operations, document the expected rollback procedure.

## Generated code

Do not hand-edit anything under `src/generated/`. Those files are regenerated from the Graph OpenAPI spec via `npm run generate`. Edit `src/endpoints.json` and regenerate instead.

## Questions

Open a [GitHub discussion](https://github.com/okapi-ca/ms-365-admin-mcp-server/discussions) or a non-security issue.
