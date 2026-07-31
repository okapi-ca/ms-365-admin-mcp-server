# Security Review — 2026-04-25

Comprehensive security review of `ms-365-admin-mcp-server` v0.6.1 covering the entire codebase. Finding IDs in this review use the `SEC-NNN` scheme (independent from the P1/P2 series `SEC-Fxx` / `SEC-Gxx` in [SECURITY_REVIEW_2026-04-20.md](./SECURITY_REVIEW_2026-04-20.md)) so remediation PRs and future reviews can reference them cleanly.

**Reviewer:** Marc Bourget (VP IT, LCI Education) — automated review run by Claude Code (`engineering:feasibility-advisor` agent), human-validated.
**Commit reviewed:** `main` @ `f2f233c` (post-v0.6.1 dependency bumps).
**Scope:** Full codebase — auth, OAuth proxy, JWT validation, secrets, HTTP transport, Graph tools, risk classification, storage, CI/CD, infrastructure (Bicep), supply chain, GDPR/PIPEDA exposure.
**Methodology:** SHIELD + STRIDE + OWASP Top 10, file-by-file inspection of `src/` (~3,434 LOC TS), `infra/main.bicep`, `.github/workflows/`, `package.json` + `npm audit --omit=dev`. No fuzzing or SAST tooling was run (out of scope for read-only review).

---

## 1. Executive summary

Posture **very strong** for an OSS project of this criticality (the server holds Microsoft Graph **application** permissions across an entire M365 tenant — a compromise potentially yields full admin access). The code shows sustained defensive discipline:

- `SEC-*` inline comments trace each control to a documented intent
- Pure-function separation `authorizeUserClaims` enables unit testing without MSAL/JWKS
- Anti prompt-injection envelope with per-call 64-bit nonce
- 100% `riskLevel` coverage on writes (186/186 mutations classified)
- OAuth-mode rate-limiting differentiated per endpoint (`/register` 10/min, `/token` 30/min, etc.)
- Fail-closed defaults — server refuses to start in `--oauth-mode` without an allowlist
- DCR client secret stored hashed with timing-safe comparison
- Bicep production defaults: Key Vault purge-protected, Storage `allowSharedKeyAccess: false`, Container App with dedicated UAMI, TLS 1.2 minimum

**0 Critical, 0 High** findings. Top 3 residual risks (all Medium):

1. **SEC-001** — `skipEncoding` path-traversal validation accepts percent-encoded forms (`%2E%2E`, `%2F`) that Graph normalizes server-side. Real surface limited (10 endpoints with strict server-side type validation), but a latent risk if a future endpoint admits a free-form string in `skipEncoding`.
2. **SEC-002** — OAuth proxy `/authorize` does not verify that the received `redirect_uri` is in the DCR-registered list. Mitigated by Entra upstream (which has its own redirect URI allowlist), but a misconfigured upstream app registration would expose a token-leak vector.
3. **SEC-003** — 3 moderate `uuid <14.0.0` advisories transitively via `@azure/msal-node@5.1.4` → `@azure/identity` → `uuid` (GHSA-w5hq-g745-h8pq). Not exploitable here (MSAL uses `uuid.v4()`); awaiting upstream MSAL bump.

**Confidence level:** high. The codebase is coherent, defensible, and the `SEC-*` discipline makes the audit reproducible. The findings below are mostly hardening or blind spots — none are production-exploitable in the recommended configuration.

**Compliance:** no GDPR / Loi 25 / PIPEDA blocker in code. At-risk patterns (verbose logs, unencrypted persistence) are absent. Default Bicep sends logs to Log Analytics in `canadaeast` — data residency compliant by default for LCI Education. UPN appears in security logs (`logger.warn`) but is necessary for incident attribution and therefore justifiable.

**Coverage tally:** 20 findings — 0 Critical, 0 High, 8 Medium, 7 Low, 5 Informational.

---

## 2. Findings table

| ID | Severity | Category | File:line | Description | Recommendation |
| --------------------------------------------------------------------- | ------------- | ------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| [SEC-001](#sec-001--skipencoding-validation-accepts-percent-encoding) | Medium | OWASP A01 / STRIDE-T | `src/graph-tools.ts:137` | `skipEncoding` regex doesn't block percent-encoded forms (`%2E%2E`, `%2F`, `%5C`). | Decode once then validate, or switch to allowlist `^[A-Za-z0-9._:-]+$`. |
| [SEC-002](#sec-002--no-redirect_uri-validation-at-dcr) | Medium | STRIDE-S | `src/oauth-proxy.ts:232-281` | `/authorize` does not verify received `redirect_uri` is in registered `redirectUris`. | Compare `redirectUri` against `known.redirectUris`; reject if not listed. |
| [SEC-003](#sec-003--uuid-vulnerabilities-transitive) | Medium | Supply chain / OWASP A06 | `package-lock.json` | `uuid <14.0.0` transitive via `@azure/msal-node@5.1.4` (3 moderate GHSA-w5hq-g745-h8pq). | Track upstream MSAL release; plan `npm audit fix --force` once a non-breaking bump exists. |
| [SEC-004](#sec-004--upn-persisted-in-logs) | Medium | OWASP A09 / STRIDE-I | `src/user-token-authorization.ts:57,79,85,96` | UPN/oid logged on every auth rejection. PII (work email) ends up in Log Analytics & disk logs without explicit redaction. | Document retention in `SECURITY.md`; consider `--redact-upn` flag or hash identifier in non-investigation logs. |
| [SEC-005](#sec-005--body-parser-exposed-before-authentication) | Medium | OWASP A04 / STRIDE-D | `src/http-server.ts:46-48` | `express.json({ limit: '100kb' })` runs BEFORE the `/mcp` rate-limiter and BEFORE bearer auth. | Place auth-middleware before `express.json()` on `/mcp`, or pre-rate-limit by IP before body parser. |
| [SEC-006](#sec-006--replace3dg--in-encoded-paths) | Medium | STRIDE-T | `src/graph-tools.ts:144,189` | `encodeURIComponent(...).replace(/%3D/g, '=')` undoes `=` encoding in paths. | Document intent of `replace(/%3D/g, '=')`; consider per-endpoint allowlist or restrict to function-style segments. |
| [SEC-007](#sec-007--state-not-bound-to-pkce-bridge) | Medium | STRIDE-T (CSRF / replay) | `src/oauth-proxy.ts:236,300` | `state` is relayed to Entra but not bound to the PKCE bridge entry. | Store `state` in PKCE entry and verify (or at least log) consistency on return; ideally emit a distinct proxy state. |
| [SEC-008](#sec-008--bicep-default-public-ingress--storage-allow) | Medium | OWASP A05 | `infra/main.bicep:321,219-221` | Container App `external: true` + Storage `networkAcls.defaultAction: 'Allow'` when `vnetIntegrated=false`. | Document `vnetIntegrated=true` as recommended for any deployment processing user data; default `defaultAction: 'Deny'` with `bypass: 'AzureServices'`. |
| SEC-009 | Low | OWASP A05 | `src/oauth-proxy.ts:133-165` | `/register` (DCR) is open and immediately returns a secret. Rate-limit 10/min mitigates but a bot can still accumulate orphan clients indefinitely. | Add TTL on unused DCR clients (purge after N days); consider optional pre-shared bootstrap secret. |
| SEC-010 | Low | STRIDE-D | `src/jwks-stale-cache.ts:17-35` | No TTL on stale JWKS keys. A revoked Entra key remains locally valid as long as JWKS endpoint is unreachable — stale-fallback serves it indefinitely. | Add timestamp on `staleCache.set(kid, key)` and refuse fallback beyond 7 days. |
| SEC-011 | Low | OWASP A02 | `src/auth-bootstrap.ts:343-348` | Tokens persisted at `~/.mcp-auth/...` mode 0600 (correct on Unix), but no protection on Windows (NTFS ACLs untouched). | Document Windows caveat in bootstrap docs; or use DPAPI / Credential Locker. |
| SEC-012 | Low | OWASP A09 | `src/graph-client.ts:36,71` | `endpoint.split('?')[0]` redacts the path's query — good practice. However `Graph error log` (line 71) includes raw `errorText` that may contain the Graph query string. | Truncate or JSON-parse `errorText` before logging to limit leakage if Graph echoes the query in its message. |
| SEC-013 | Low | OWASP A09 | `src/storage/table-storage.ts:47-49` | `DefaultAzureCredential` chains available credentials (env, MI, VS, Az CLI…). In dev, may accidentally use a personal account. | Document the chain; recommend explicit `AZURE_CLIENT_ID` in prod (already done in Bicep, line 352-353 — good point). |
| SEC-014 | Low | OWASP A03 | `src/graph-tools.ts:286` | `paramSchema[param.name] = (param.schema                                                                                                                                 |                                                                                                                                                        | z.unknown()).optional()`—`z.unknown()` fallback accepts anything. | Inspect proportion of endpoints landing on this fallback; consider `z.record(z.unknown())` to at least force an object. |
| SEC-015 | Low | OWASP A02 | `src/oauth-proxy.ts:156` | `client_secret_expires_at: 0` (never expires) on DCR secrets. Combined with no auto-purge (SEC-009), DCR secrets are eternal. | Set default rotation at 90 or 180 days (`Date.now()/1000 + N*86400`) and purge expired entries. |
| SEC-016 | Informational | Process | `.github/workflows/ci.yml:4-5` | CI uses `pull_request` (not `pull_request_target`) — good default, no secret leak to fork PRs. | OK — keep `pull_request`. |
| SEC-017 | Informational | Process | `.github/workflows/ci.yml:19`, `release.yml:25,37,54,92` | `actions/checkout@v6` not pinned by SHA — current spec is mutable tag. | For an OSS repo publishing binaries (npm provenance + Docker GHCR), pinning by SHA reduces action-supply-chain attack surface. |
| SEC-018 | Informational | OWASP A09 | `src/logger.ts:8-13` | Log directory (`~/.ms365-admin-mcp/logs`) created with `mode: 0o700` — correct. But `winston.transports.File` doesn't apply file mode (umask default). | Force `options: { mode: 0o600 }` on `File` transports (Winston supports this parameter). |
| SEC-019 | Informational | STRIDE-I | `src/auth.ts:148-159`, `src/graph-client.ts:69-84` | Graph error sanitization: server-side log of raw `errorText`, parsed return to client. Good pattern. OK. | OK. |
| SEC-020 | Informational | OWASP A07 | `src/token-validator.ts:92-96` | `clockTolerance: 30` — reasonable. `algorithms: ['RS256']` — protects against `alg=none` and HS256 confusion. OK. | OK. |

---

## 3. Detailed findings (Medium)

### SEC-001 — `skipEncoding` validation accepts percent-encoding

**File:line:** `src/graph-tools.ts:137`

```ts
const raw = paramValue as string;
if (/[/\\?#&]|\.\./.test(raw)) {
  throw new Error(...);
}
encodedValue = raw;
```

**Attack vector:** an LLM operator (or a prompt injection that escaped the SEC-G02 envelope) calls `get-pstn-calls` with `fromDateTime=%2E%2E%2F%2E%2E%2Fusers`. The SEC-A regex inspects the _raw string_ — `%2E%2E` is not literal `..` and passes. Microsoft Graph decodes `%2E%2E` server-side as `..`, potentially altering OData resolution.

**Impact:** limited in practice. The 10 `skipEncoding` endpoints are:

- 4 endpoints `getXxxActivityCounts(period='{period}')` — Graph strictly validates `D7|D30|D90|D180` server-side, an encoded invalid value returns 400.
- 4 endpoints `getXxxUserDetail(period='{period}')` — same.
- 2 endpoints `getPstnCalls / getDirectRoutingCalls` — ISO 8601 datetimes, strict Graph validation.

Real exploitation requires a `skipEncoding` endpoint that _would accept_ an arbitrary value — none today in `endpoints.json`. But adding a future function-style endpoint with a user identifier in `skipEncoding` would open the door. This is a latent risk, not a current exploit.

**Recommendation:** replace with allowlist:

```ts
// Blocks any character outside [A-Za-z0-9._:-] (covers D7, ISO 8601 datetimes,
// most function-style params). Also blocks percent encoding which is never
// legitimate in these formats.
if (!/^[A-Za-z0-9._:-]+$/.test(raw)) {
  throw new Error(...);
}
```

If future params need non-ASCII (unlikely for function-style), use a per-endpoint allowlist in `endpoints.json` rather than a permissive default.

---

### SEC-002 — No `redirect_uri` validation at DCR

**File:line:** `src/oauth-proxy.ts:232-281` (`/authorize`), `src/oauth-proxy.ts:343-381` (`/token`)

```ts
// /authorize — known is fetched by clientId but redirectUri is never compared to known.redirectUris
const known = await storage.getClient(clientId);
if (!known) { ... }
// known.redirectUris never read
const serverVerifier = randomVerifier();
await storage.savePkce({
  clientChallenge,
  serverVerifier,
  redirectUri,         // ← attacker-supplied, not validated
  clientId,
  ...
});
```

**Attack vector:** a DCR client registers `redirect_uris: ["http://localhost:3000/cb"]`. Later, an attacker who possesses `client_id + client_secret` (e.g. saw them in a `~/.mcp-auth/...` cache on a multi-user host) calls `/authorize?client_id=...&redirect_uri=https://attacker.example.com/cb`. The proxy doesn't compare — Entra will refuse _if_ the upstream app registration is configured with a strict redirect URI allowlist.

**Impact:** downgrade attack mitigated by Entra upstream. But if the operator has configured the upstream app registration with a wildcard or loose schema (common in dev), the MCP proxy becomes an open-redirect / token-leak vector.

**Recommendation:**

```ts
// After getClient(clientId)
if (known.redirectUris.length > 0 && !known.redirectUris.includes(redirectUri)) {
  logger.warn(`OAuth /authorize rejected: redirect_uri ${redirectUri} not in registered list`);
  res
    .status(400)
    .json({ error: 'invalid_request', error_description: 'redirect_uri not registered' });
  return;
}
```

Same at `/token` (`bridge.redirectUri` should match `body.redirect_uri`).

---

### SEC-003 — `uuid` vulnerabilities transitive

**Source:** `npm audit --omit=dev`

```
uuid  <14.0.0  (moderate)
GHSA-w5hq-g745-h8pq — Missing buffer bounds check in v3/v5/v6 when buf is provided
@azure/msal-node@5.1.4 → @azure/identity → uuid
3 moderate severity vulnerabilities
```

**Impact:** exploitation requires an attacker to control the destination buffer passed to `uuid.v3/v5/v6` — not the case in this codebase (MSAL uses `uuid.v4()` internally). Real risk = very low but flagged.

**Recommendation:**

- No urgent action. `npm audit fix --force` would break MSAL (downgrade to `@azure/identity@1.x`).
- Watch the next `@azure/msal-node` release (changelog) — Microsoft should bump `uuid` in the coming weeks.
- Add a comment in `package.json` or a `RISKS.md` to track the debt.

---

### SEC-004 — UPN persisted in logs

**File:line:** `src/user-token-authorization.ts:57,79,85,96`; `src/http-server.ts:109`; `src/oauth-proxy.ts:332,369`

```ts
logger.warn(
  `User oid ${oid} (${payload.upn || payload.preferred_username || 'no upn'}) not in authorized-users allowlist`
);
logger.info(`MCP request authenticated as user ${userClaims.upn ?? userClaims.oid}`);
```

**Attack vector:** not an attack vector; a compliance risk. MCP server logs contain UPN (work email = personal data per GDPR/Loi 25/PIPEDA). The Bicep deployment ships everything to Log Analytics with `logRetentionDays: 30` — short (good for minimization), but undocumented in SECURITY.md or README so an LCI Education operator can't easily complete a DPIA inventory.

**Impact:** GDPR/Loi 25 exposure if:

- An operator deploys this server in a non-EU region for EU users.
- Logs are exported to a third-party SIEM without DPA.
- An incident reveals logs were retained beyond necessity.

**Recommendation:**

1. Add a "Personal data logged" section in `SECURITY.md` listing: UPN, Entra oid, source IP (via Express logs).
2. Document default retention and procedure to lower it in README.
3. Optional — add `--log-redact-upn` option that replaces UPN by SHA256 hash in all logs except `LOG_LEVEL=debug`.

---

### SEC-005 — Body parser exposed before authentication

**File:line:** `src/http-server.ts:46-59`

```ts
app.use(securityHeaders);
app.use(express.json({ limit: '100kb' }));         // ← consumes CPU/memory BEFORE auth
app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use('/mcp', rateLimit({ windowMs: 60_000, max: 100, ... }));   // ← gating after parse
```

**Attack vector:** an unauthenticated attacker sends 100 req at 100 KB each (= 10 MB) via /mcp — each request is parsed as JSON by Express before the rate-limiter examines the window. The limiter caps at 100 req/min but the body parser has already consumed memory.

**Impact:** amplified DoS. With a distributed attacker (botnet, or simply multiple `--allowed-clients`), the JSON parser becomes a memory exhaustion surface. Azure Container Apps containers have 1 GiB by default (cf. Bicep line 344), so an unrate-limited attacker can pin the pod.

**Recommendation:**

- Reorder: `rateLimit({ ... })` global (per IP) BEFORE the body parser, with a separate cap (e.g. 200 req/min per IP); keep current `/mcp` rate-limiter.
- Or simpler: apply the `/mcp` rate-limiter without `app.use('/mcp', ...)` but via a middleware at the very top that filters the path manually before body parsing.

---

### SEC-006 — `replace(/%3D/g, '=')` post-encoding in paths

**File:line:** `src/graph-tools.ts:144,189`

```ts
encodedValue = encodeURIComponent(paramValue as string).replace(/%3D/g, '=');
```

**Context:** `=` is likely needed for Graph function-style paths like `getPstnCalls(fromDateTime={fromDateTime},toDateTime={toDateTime})` where an argument value can contain `=` (e.g. in an OData base64 GUID). But this substitution happens BEFORE insertion into the path.

**Attack vector:** an operator passes `userId="alice@contoso.com=admin'or'1=1"`. `encodeURIComponent` encodes everything except ASCII alphanumerics + `-_.~!*'()`. `=` becomes `%3D`. The substitution restores `=` → final path contains an unencoded `=` that may alter OData semantics.

**Impact:** limited because Graph validates OData types (a `userId` GUID is strict). But this is an ad-hoc convention undocumented in the code that could regress on a future endpoint accepting a free string in a path param.

**Recommendation:** comment explicitly in the code why `=` is undecoded, and ideally do it only for `(...)` path segments (function-style). Suggested pattern:

```ts
// Function-style Graph paths use 'arg=value' literal. Restore the '=' that
// encodeURIComponent escaped, but only inside function-call segments to avoid
// altering OData semantics for normal path segments.
```

---

### SEC-007 — `state` not bound to PKCE bridge

**File:line:** `src/oauth-proxy.ts:236,300`

```ts
const { ..., state, ... } = req.query as Record<string, string | undefined>;
...
if (state) upstream.searchParams.set('state', state);
```

**Attack vector:** an attacker forces a victim to initiate an `/authorize` flow with `state=attacker_chosen`. If the `state` returned to the victim matches, the client may be tricked into processing an attacker-supplied auth code (classic session-fixation).

**Impact:** PKCE bridge mitigates (the code is only usable by who holds the `code_verifier`), but `state` not bound to PKCE entry means client-side correlation depends solely on the client. IETF convention (RFC 6819 §5.3.5) recommends binding `state` to `code_challenge`.

**Recommendation:** store `state` in the `PkceEntry` at `/authorize`, and at minimum log it during `/token` to trace any anomaly. Ideally: emit a distinct proxy `state`, keep client state in parallel, and restore client state at the final redirect.

---

### SEC-008 — Bicep default: public ingress + Storage `defaultAction: Allow`

**File:line:** `infra/main.bicep:218-223,321`

```bicep
// Storage account
networkAcls: {
  defaultAction: 'Allow'
  bypass: 'AzureServices'
}
// Container App
ingress: {
  external: true
  ...
}
```

**Attack vector:** any operator copying `parameters.example.jsonc` without setting `vnetIntegrated=true` deploys:

- a Container App reachable from the Internet (yes, JWT-protected, but exposed attack surface),
- a Storage Account (PKCE bridge + DCR clients) reachable from any IP (mitigation: `allowSharedKeyAccess: false`, so only the OAuth ManagedIdentity can write — but the OAuth Azure surface remains public).

**Impact:** for LCI Education in particular (PIPEDA + Loi 25), a default deployment potentially creates residency non-compliance when storing in Tables `redirectUris` and `clientChallenge` which are technical data but traceable to a user.

**Recommendation:**

- Force `defaultAction: 'Deny'` with an IP whitelist or `bypass: 'AzureServices'` + Container App MI in the same subscription.
- Document that `vnetIntegrated=true` is the recommended mode for any deployment processing real users.
- Add a Bicep check that rejects `vnetIntegrated=false && oauthMode=true` with a warning.

---

## 4. Positive observations

1. **`SEC-*` discipline throughout the code** — every security control traces to a documented intent. Exemplary, makes the audit reproducible.
2. **Fail-closed by default** — `--oauth-mode` without `--authorized-users` nor `--allow-any-tenant-user` refuses to start (`server.ts:107-113`). `--public-url` required and validated (SEC-F02). `effectiveRiskLevel` defaults missing write to `critical` (`risk-level.ts:43-45`).
3. **Pure-function `authorizeUserClaims` separation** — testable without loading MSAL/JWKS. Excellent testability discipline (`user-token-authorization.ts`).
4. **Anti prompt-injection envelope with per-call nonce** — `untrusted-envelope.ts` generates a 64-bit random nonce per call; the test `attacker-controlled payload containing the literal close tag cannot escape the envelope` confirms it. Solid pattern.
5. **Hash + timing-safe DCR secret comparison** — `oauth-storage.ts:34-39` uses `timingSafeEqual` correctly, with Buffer length normalization before comparison.
6. **Coherent risk classification** — 100% of writes have `riskLevel`; 23 sensitive GETs (BitLocker keys, LAPS passwords, etc.) are also annotated. Sampling 15 critical / 30 high tools confirms `delete-user`, `delete-conditional-access-policy`, `wipe-managed-device`, `add-directory-role-member`, `create-pim-role-assignment-request` are all `critical`. One flag to examine: `disable-lost-mode` at `low` (probably OK: disabling lost mode, not critical).
7. **Solid Bicep** — Key Vault with `enablePurgeProtection: true`, `softDeleteRetentionInDays: 90`, `enableRbacAuthorization: true`. Storage with `allowSharedKeyAccess: false`, `minimumTlsVersion: TLS1_2`, `defaultToOAuthAuthentication: true`. Container App with dedicated UAMI (no System-Assigned).
8. **Secret cache** in `secrets.ts:90-99` — simple cache, no TTL exposed to attacker. Manual refresh via `clearSecretsCache()`.
9. **Tenant `common` rejected** (`auth.ts:95-100`) with clear message. Prevents accidental multi-tenant deployment on application permissions.
10. **Sanitized upstream errors** (`upstream-error.ts`) — extracts only `error`, `error_description`, `error_codes` (RFC 6749 + Microsoft extension fields). No leakage of correlation IDs or trace fragments.
11. **Dedicated SEC tests** — `untrusted-envelope.test.ts` explicitly tests the close-tag attack, `oauth-proxy.test.ts` tests SEC-F04b client_id mismatch, `risk-level.test.ts` tests gating, `jwks-stale-cache.test.ts` tests fallback. Explicit SEC coverage is rare and valuable.
12. **CI on `pull_request` (not `_target`)** + Node 18/20/22 matrix — good default, no secret leak to fork PRs.

---

## 5. Strategic recommendations (non-findings)

### a. Supply chain & releases

1. **Pin `actions/checkout` and friends by SHA** (cf. SEC-017). For an OSS project publishing on npm with `--provenance` and on GHCR, this is consistent with the security image projected.
2. **Systematic SBOM at each release** — `npm sbom` (CycloneDX) or `syft` Docker-side. Publish SBOM as GitHub Release artifact. Allows downstream operators to track dependencies.
3. **Trivy / Grype scan in Docker workflow** — `aquasecurity/trivy-action` on the generated image, fail-fast on Critical CVE.
4. **OSSF Scorecard** — add Scorecard workflow to measure OSS security posture (branch protection, signed releases, dependency-update tooling). Score visible on PRs / downstream consumers.

### b. MCP-specific hardening

5. **Fuzzing CI on Graph paths** — small vitest harness injecting pathological strings (`%2E`, `%00`, UTF-16 surrogate halves, RTL override) into all `Path`/`Query` params and verifying that `executeGraphTool` rejects/encodes properly. Would catch SEC-001 and any future encoding bug.
6. **End-to-end `validateEntraToken` unit test** — pure `authorizeUserClaims` is covered but `validateEntraToken` (signature + algorithms enforcement) has no direct test. Mock JWKS and test: `alg=none` rejected, bogus signature rejected, expired exp rejected, unknown kid rejected.
7. **Configurable cap on total registered tools** — prevents an operator from launching with `--max-risk-level critical --allow-writes` and 515 tools visible in LLM context (which may exceed context budget). Not pure security risk, but operational guardrail.

### c. Compliance / process

8. **"Operator hardening for regulated tenants" section in `SECURITY.md`** — explicitly address:
   - Which logs contain personal data?
   - Default retention, how to modulate?
   - Data residency for logs (Log Analytics workspace region)?
   - DPA flow if a third-party MSSP consumes logs?
9. **DPIA template** — for LCI Education in particular: short template (1 page) listing PII flows handled by this server (UPN in logs, oid persisted in Azure Tables, IP via Express). Allows Mery Paz Monroy (LCI Privacy Officer) to instantiate quickly.
10. **Explicit list of `excluded-by-policy` tools** — for LCI deployments, many tools should NEVER be exposed (e.g. `wipe-managed-device`, `delete-ediscovery-case`). Document in `SECURITY.md` a "regulated-default" `--enabled-tools` preset that excludes any `riskLevel: critical` even with `--allow-writes`.

### d. Future defensive coverage

11. **Anti-replay on `oid + jti`** — currently a valid user token can be replayed N times until expiration. An LRU cache on `(oid, jti)` consumed would block replay (but operational cost: Tables/Redis). To consider if interception threat is high.
12. **Optional MTLS for `--allowed-clients`** — for max-criticality service-to-service flows, a client certificate in addition to JWT eliminates token-leak attack classes.
13. **Audit trail in the server itself** — currently Graph calls are logged in winston, but a structured audit journal (JSON line per tool call with `oid`, `tool_alias`, `riskLevel`, `outcome`) would cleanly answer `who did what when` without depending on Microsoft Audit Logs (30+ minute latency).

---

## 6. Files inspected

- `src/auth.ts`, `src/auth-bootstrap.ts`, `src/secrets.ts`
- `src/token-validator.ts`, `src/user-token-validator.ts`, `src/user-token-authorization.ts`, `src/jwks-stale-cache.ts`
- `src/oauth-proxy.ts`, `src/oauth-rate-limiters.ts`
- `src/http-server.ts`, `src/server.ts`, `src/index.ts`, `src/cli.ts`
- `src/graph-client.ts`, `src/graph-tools.ts`, `src/cloud-config.ts`, `src/logger.ts`
- `src/risk-level.ts`, `src/tool-categories.ts`, `src/untrusted-envelope.ts`, `src/upstream-error.ts`
- `src/storage/index.ts`, `src/storage/memory-storage.ts`, `src/storage/oauth-storage.ts`, `src/storage/table-storage.ts`
- `src/endpoints.json` (sampling: all critical/medium writes, conditional access, PIM, eDiscovery, skipEncoding endpoints)
- `infra/main.bicep`
- `Dockerfile`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`
- `package.json`, `tsconfig.json`, `.gitignore`, `.dockerignore`
- `SECURITY.md`, `test/*.test.ts` (to calibrate defensive coverage)

`npm audit --omit=dev` executed; no fuzzing/SAST tools run (out of scope, read-only review).

---

## 7. Tracking

The 8 Medium findings ([SEC-001](#sec-001--skipencoding-validation-accepts-percent-encoding) through [SEC-008](#sec-008--bicep-default-public-ingress--storage-allow)) are tracked as GitHub issues in `okapi-ca/ms-365-admin-mcp-server` under the `security` label.

| Finding | GitHub                                                               |
| ------- | -------------------------------------------------------------------- |
| SEC-001 | [#68](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/68) |
| SEC-002 | [#69](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/69) |
| SEC-003 | [#70](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/70) |
| SEC-004 | [#71](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/71) |
| SEC-005 | [#72](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/72) |
| SEC-006 | [#73](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/73) |
| SEC-007 | [#74](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/74) |
| SEC-008 | [#75](https://github.com/okapi-ca/ms-365-admin-mcp-server/issues/75) |

Lows and Informationals (SEC-009 through SEC-020) are tracked in this document only and will be revisited at the next periodic review.
