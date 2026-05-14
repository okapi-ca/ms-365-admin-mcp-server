/**
 * SEC-G01: ranked risk-level model for tool registration.
 *
 * Tools ship with an explicit `riskLevel` annotation (set for 100 % of
 * write endpoints and for the ~20 sensitive-read GETs covered by SEC-G03).
 * The registration pipeline caps the level it will expose based on the
 * `--max-risk-level` CLI flag. Pure module so the gate logic can be
 * unit-tested without the full MCP/Graph stack.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export const RISK_LEVELS: readonly RiskLevel[] = ['low', 'medium', 'high', 'critical'] as const;

export function rank(level: RiskLevel): number {
  return RISK_LEVELS.indexOf(level);
}

export function isValidRiskLevel(x: unknown): x is RiskLevel {
  return typeof x === 'string' && (RISK_LEVELS as readonly string[]).includes(x);
}

export function parseMaxRiskLevel(raw: string): RiskLevel {
  const lower = raw.toLowerCase();
  if (!isValidRiskLevel(lower)) {
    throw new Error(`Invalid --max-risk-level: ${raw}. Must be one of: ${RISK_LEVELS.join(', ')}`);
  }
  return lower;
}

/**
 * Effective risk level for a tool:
 *   - If `configuredRiskLevel` is set, use it.
 *   - Else GET endpoints default to `low` (safe reads).
 *   - Else (a write without an explicit level) default to `critical` — fail-safe
 *     so a future endpoint missing an annotation is not silently leaked under
 *     a medium cap.
 */
export function effectiveRiskLevel(
  configuredRiskLevel: RiskLevel | undefined,
  method: string
): RiskLevel {
  if (configuredRiskLevel) return configuredRiskLevel;
  return method.toUpperCase() === 'GET' ? 'low' : 'critical';
}

export function isToolAllowed(
  configuredRiskLevel: RiskLevel | undefined,
  method: string,
  maxRiskLevel: RiskLevel
): boolean {
  return rank(effectiveRiskLevel(configuredRiskLevel, method)) <= rank(maxRiskLevel);
}

/**
 * Map Entra App Role assignments on this app registration to the set of
 * write-tier `RiskLevel`s the caller is authorized to invoke.
 *
 * Three independent roles (additive, no implicit hierarchy):
 *   - `Tools.Write.LowMedium` → grants `low` + `medium`
 *   - `Tools.Write.High`      → grants `high`
 *   - `Tools.Write.Critical`  → grants `critical`
 *
 * Returns:
 *   - `undefined` when `roles === undefined`: caller identity not available
 *     (stdio transport) — fall back to the existing `--allow-writes` /
 *     `--max-risk-level` controls without an extra per-caller filter.
 *   - empty `Set` when authenticated but no Tools.Write.* role is assigned:
 *     caller is effectively read-only for this session.
 *   - populated `Set` otherwise: registration pipeline includes only writes
 *     whose effective tier is in the set.
 *
 * This filter composes in AND with `--max-risk-level` — a tier present in
 * the set but excluded by the global cap stays excluded.
 */
export function computeWriteRiskTiers(roles: string[] | undefined): Set<RiskLevel> | undefined {
  if (roles === undefined) return undefined;
  const tiers = new Set<RiskLevel>();
  if (roles.includes('Tools.Write.LowMedium')) {
    tiers.add('low');
    tiers.add('medium');
  }
  if (roles.includes('Tools.Write.High')) tiers.add('high');
  if (roles.includes('Tools.Write.Critical')) tiers.add('critical');
  return tiers;
}
